import { config } from './config';
import { RuntimeStateFileStore } from './file-store';
import { RuntimeStateNormalizer } from './normalizer';

import type { RuntimeCommand, RuntimeState } from '@ungate/shared/frontend';

export class RuntimeStateStore {
	public static read(): RuntimeState {
		return RuntimeStateFileStore.read();
	}

	public static write(next: RuntimeState): void {
		RuntimeStateFileStore.write(next);
	}

	public static mutate(mutator: (current: RuntimeState) => RuntimeState): Promise<RuntimeState> {
		return RuntimeStateFileStore.mutate(mutator);
	}

	public static async touchClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const now = Date.now();
			const clients = RuntimeStateNormalizer.filterLiveClients(current.clients, now);
			const previous = clients[windowId];

			if (!previous || now - previous.lastSeenAt >= config.runtimeState.heartbeatThrottleMs) {
				clients[windowId] = { lastSeenAt: now };
			}

			current.clients = clients;

			return current;
		});
	}

	public static async removeClient(windowId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			const clients = { ...current.clients };
			delete clients[windowId];
			current.clients = clients;

			return current;
		});
	}

	public static getLiveClientIds(state: RuntimeState, now = Date.now()): string[] {
		return Object.entries(state.clients)
			.filter(([, entry]) => now - entry.lastSeenAt <= config.runtimeState.staleClientMs)
			.map(([id]) => id);
	}

	public static hasLiveClients(state: RuntimeState, now = Date.now()): boolean {
		return this.getLiveClientIds(state, now).length > 0;
	}

	public static getLeaderWindowId(state: RuntimeState, now = Date.now()): string | null {
		const live = this.getLiveClientIds(state, now).sort();

		if (live.length === 0) {
			return null;
		}

		return live[0];
	}

	public static getFilePath(): string {
		return RuntimeStateFileStore.getFilePath();
	}

	public static async enqueueCommand(command: RuntimeCommand): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands.push(command);

			return current;
		});
	}

	public static peekCommand(): RuntimeCommand | null {
		const state = this.read();

		if (state.commands.length === 0) {
			return null;
		}

		return state.commands[0];
	}

	public static async removeCommand(commandId: string): Promise<RuntimeState> {
		return await this.mutate((current) => {
			current.commands = current.commands.filter((command) => command.id !== commandId);

			return current;
		});
	}
}
