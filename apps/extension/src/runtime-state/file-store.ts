import * as fs from 'node:fs';

import { sleep, type RuntimeState } from '@ungate/shared/frontend';

import { config } from './config';
import { RuntimeStateDefaults } from './default-state';
import { RuntimeStateNormalizer } from './normalizer';

export class RuntimeStateFileStore {
	public static read(): RuntimeState {
		this.ensureStorage();
		const fallback = RuntimeStateDefaults.create();

		if (!fs.existsSync(config.paths.stateFilePath)) {
			return fallback;
		}

		try {
			const raw = fs.readFileSync(config.paths.stateFilePath, 'utf8');
			const parsed = JSON.parse(raw) as Partial<RuntimeState>;

			return RuntimeStateNormalizer.normalize(parsed);
		} catch {
			return fallback;
		}
	}

	public static write(next: RuntimeState): void {
		this.ensureStorage();
		const temp = `${config.paths.stateFilePath}.tmp`;
		fs.writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
		fs.renameSync(temp, config.paths.stateFilePath);
	}

	public static async mutate(mutator: (current: RuntimeState) => RuntimeState): Promise<RuntimeState> {
		this.ensureStorage();
		await this.acquireLock();

		try {
			const current = this.read();
			const next = mutator(current);
			this.write(next);

			return next;
		} finally {
			this.releaseLock();
		}
	}

	public static getFilePath(): string {
		return config.paths.stateFilePath;
	}

	private static ensureStorage(): void {
		fs.mkdirSync(config.baseDir, { recursive: true });
	}

	private static async acquireLock(): Promise<void> {
		const startedAt = Date.now();

		while (true) {
			try {
				fs.mkdirSync(config.paths.lockPath);

				return;
			} catch (error: unknown) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				const isAlreadyExists = code === 'EEXIST';

				if (!isAlreadyExists) {
					throw error;
				}

				if (Date.now() - startedAt > config.runtimeState.lockTimeoutMs) {
					this.releaseLock();
					fs.mkdirSync(config.paths.lockPath, { recursive: true });

					return;
				}

				await sleep(10);
			}
		}
	}

	private static releaseLock(): void {
		try {
			fs.rmdirSync(config.paths.lockPath);
		} catch {}
	}
}
