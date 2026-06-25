import { platform, arch } from 'node:os';

import { logger } from 'src/utils/logger';

import { config } from '../config';
import { Settings } from '../database/app-settings';

import type { AnthropicRequest, ContentBlock, ThinkingEffort } from '../types';

const VALID_EFFORTS: readonly ThinkingEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Opus 4.7/4.8 reject manual budget_tokens (400). They use adaptive thinking,
// controlled by the `effort` parameter in a top-level `output_config` object.
// Map the internal reasoning_budget tier onto an effort level.
function resolveEffort(budget: number | string | undefined): ThinkingEffort | null {
	if (typeof budget === 'string') {
		const normalized = budget.toLowerCase();

		return (VALID_EFFORTS as readonly string[]).includes(normalized) ? (normalized as ThinkingEffort) : null;
	}

	if (typeof budget === 'number') {
		if (budget <= 0) return null;
		if (budget <= 4000) return 'low';
		if (budget <= 10000) return 'medium';
		if (budget <= 31999) return 'high';

		return 'xhigh';
	}

	return null;
}

export class RequestBuilder {
	private static getStainlessOS(): string {
		const p = platform();
		switch (p) {
			case 'darwin':
				return 'MacOS';
			case 'linux':
				return 'Linux';
			case 'win32':
				return 'Windows';
			default:
				return 'Unknown';
		}
	}

	private static getStainlessArch(): string {
		const a = arch();
		switch (a) {
			case 'arm64':
				return 'arm64';
			case 'x64':
				return 'x64';
			case 'arm':
				return 'arm';
			default:
				return 'unknown';
		}
	}

	static getStainlessHeaders(): Record<string, string> {
		return {
			'x-stainless-arch': this.getStainlessArch(),
			'x-stainless-lang': 'js',
			'x-stainless-os': this.getStainlessOS(),
			'x-stainless-package-version': '0.70.0',
			'x-stainless-retry-count': '0',
			'x-stainless-runtime': 'node',
			'x-stainless-runtime-version': process.version,
			'x-stainless-timeout': '600'
		};
	}

	private static stripCacheTtl(content: ContentBlock[] | undefined): void {
		if (!Array.isArray(content)) return;

		for (const item of content) {
			if (item && typeof item === 'object' && 'cache_control' in item) {
				const cc = item.cache_control as Record<string, unknown>;

				if (cc && 'ttl' in cc) {
					delete cc.ttl;
				}
			}
		}
	}

	static prepareClaudeCodeBody(body: AnthropicRequest): AnthropicRequest {
		const prepared = { ...body };

		if ('reasoning_budget' in prepared) {
			const budgetValue = prepared.reasoning_budget;
			delete prepared.reasoning_budget;

			// Translate the tier into adaptive thinking + effort. Opus 4.7/4.8 only
			// support this form; manual budget_tokens returns a 400. `effort` has no
			// effect without `thinking.type: "adaptive"`, so both must be set.
			const effort = resolveEffort(budgetValue);

			if (effort) {
				prepared.thinking = { type: 'adaptive' };
				prepared.output_config = { ...prepared.output_config, effort };
				logger.log(`Reasoning budget (${budgetValue}) → adaptive thinking (effort: ${effort})`);
			} else {
				logger.log(`Reasoning budget (${budgetValue}) ignored — no matching effort tier`);
			}
		}

		const systemPrompts: ContentBlock[] = [];

		if (config.claudeCode.systemPrompt) {
			systemPrompts.push({ type: 'text', text: config.claudeCode.systemPrompt });
		}

		const extraInstruction = Settings.get().extraInstruction;

		if (extraInstruction) {
			systemPrompts.push({ type: 'text', text: extraInstruction });
		}

		if (prepared.system) {
			if (typeof prepared.system === 'string') {
				systemPrompts.push({ type: 'text', text: prepared.system });
			} else if (Array.isArray(prepared.system)) {
				systemPrompts.push(...prepared.system);
			}
		}

		prepared.system = systemPrompts;

		if (Array.isArray(prepared.system)) {
			this.stripCacheTtl(prepared.system);
		}

		if (Array.isArray(prepared.messages)) {
			for (const message of prepared.messages) {
				if (Array.isArray(message.content)) {
					this.stripCacheTtl(message.content);
				}
			}
		}

		return prepared;
	}
}
