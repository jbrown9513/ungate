import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

import type { RuntimeState } from '@ungate/shared/frontend';

const runtimeReadMock = vi.fn<() => RuntimeState>();
const runtimeHasLiveClientsMock = vi.fn<(state: RuntimeState) => boolean>();
const runtimeMutateMock = vi.fn<(mutator: (current: RuntimeState) => RuntimeState) => Promise<RuntimeState>>();
const sleepMock = vi.fn<(ms: number) => Promise<void>>();

vi.mock('@ungate/shared', () => {
	return {
		sleep: sleepMock
	};
});

vi.mock('vscode', () => {
	return {
		ExtensionMode: {
			Development: 1,
			Production: 2
		}
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: runtimeReadMock,
			hasLiveClients: runtimeHasLiveClientsMock,
			mutate: runtimeMutateMock
		}
	};
});

let ApiServer: typeof import('../../src/api-server').ApiServer;

interface ApiServerInternals {
	port: number | null;
	process: null;
	lastStatus: 'running' | 'stopped' | 'error' | null;
	restartRequested: boolean;
	shutDownDeliberately: boolean;
	runHealthCheckCycle(): Promise<void>;
	onExit(code: number | null, signal: NodeJS.Signals | null): void;
	spawn(): void;
	isProcessAlive(pid: number): boolean;
	checkPortHealth(port: number): Promise<boolean>;
	startHealthCheck(): void;
}

function createRuntimeState(): RuntimeState {
	const runtimeState = TestHelper.createRuntimeState([], 4783);

	return runtimeState;
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function getInternals(server: InstanceType<typeof ApiServer>): ApiServerInternals {
	return server as unknown as ApiServerInternals;
}

function createServer(options?: { isLeaderWindow?: boolean; isExtensionHostActive?: boolean }): {
	server: InstanceType<typeof ApiServer>;
	onStatusChange: ReturnType<typeof vi.fn>;
	onPortDetected: ReturnType<typeof vi.fn>;
	onLog: ReturnType<typeof vi.fn>;
} {
	const onStatusChange = vi.fn();
	const onPortDetected = vi.fn();
	const onLog = vi.fn();
	const server = new ApiServer(
		{
			extensionMode: 1,
			extensionPath: '/tmp/ungate-extension'
		} as never,
		{
			onLog,
			onPortDetected,
			onStatusChange,
			isLeaderWindow() {
				return options?.isLeaderWindow ?? true;
			},
			isExtensionHostActive() {
				return options?.isExtensionHostActive ?? true;
			}
		}
	);

	return { server, onStatusChange, onPortDetected, onLog };
}

describe('ApiServer.runHealthCheckCycle', () => {
	beforeAll(async () => {
		const module = await import('../../src/api-server');
		ApiServer = module.ApiServer;
	});

	beforeEach(() => {
		runtimeReadMock.mockReset();
		runtimeHasLiveClientsMock.mockReset();
		runtimeMutateMock.mockReset();
		sleepMock.mockReset();
		sleepMock.mockResolvedValue(undefined);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('does not mark attached running api as stopped after a transient health-check failure', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.reject(new Error('temporary network failure'));
			})
		);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();

		expect(onStatusChange).not.toHaveBeenCalledWith('stopped');
	});

	it('attaches to an existing healthy api without spawning a new process', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});
		vi.spyOn(internals, 'isProcessAlive').mockReturnValue(true);
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
		expect(onPortDetected).toHaveBeenCalledWith(4783);
		expect(onStatusChange).toHaveBeenCalledWith('running');
	});

	it('does not spawn a second process when start is called again during local startup', async () => {
		const runtimeState = createRuntimeState();
		const { server } = createServer();
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			process: {}
		});

		await server.start();

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('does not stop api before the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(2500);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});

	it('stops api after the no-clients grace period elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: false });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		await internals.runHealthCheckCycle();
		vi.setSystemTime(3001);
		await internals.runHealthCheckCycle();

		expect(stopSpy).toHaveBeenCalledTimes(1);
	});

	it('does not stop api when extension host is still active', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);

		const runtimeState = createRuntimeState();
		const { server } = createServer({ isExtensionHostActive: true });
		const internals = getInternals(server);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				return Promise.resolve({ ok: true });
			})
		);
		const stopSpy = vi.spyOn(server, 'stop').mockResolvedValue(undefined);

		Object.assign(internals, {
			port: 4783,
			lastStatus: 'running',
			process: null
		});

		vi.setSystemTime(5000);
		await internals.runHealthCheckCycle();

		expect(stopSpy).not.toHaveBeenCalled();
	});
});

describe('ApiServer.onExit', () => {
	beforeEach(() => {
		sleepMock.mockReset();
		sleepMock.mockResolvedValue(undefined);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(createRuntimeState());

			return Promise.resolve(nextState);
		});
	});

	it('respawns after a requested restart', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			restartRequested: true,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(sleepMock).toHaveBeenCalledTimes(1);
	});

	it('does not respawn after a deliberate shutdown', () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			shutDownDeliberately: true,
			process: null
		});

		internals.onExit(0, null);

		expect(spawnSpy).not.toHaveBeenCalled();
	});

	it('respawns after a clean exit', async () => {
		const { server } = createServer();
		const internals = getInternals(server);
		const spawnSpy = vi.spyOn(internals, 'spawn').mockImplementation(() => {});

		Object.assign(internals, {
			restartRequested: false,
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(0, null);
		await flushPromises();

		expect(spawnSpy).toHaveBeenCalledTimes(1);
		expect(sleepMock).toHaveBeenCalledTimes(1);
	});

	it('marks status as error after a non-zero exit', async () => {
		const runtimeState = createRuntimeState();
		const { server, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});

		Object.assign(internals, {
			restartRequested: false,
			shutDownDeliberately: false,
			process: null
		});

		internals.onExit(1, null);
		await flushPromises();

		expect(onStatusChange).toHaveBeenCalledWith('error');
	});

	it('attaches to an already running api after EADDRINUSE instead of staying in error', async () => {
		const runtimeState = createRuntimeState();
		const { server, onPortDetected, onStatusChange } = createServer();
		const internals = getInternals(server);
		runtimeMutateMock.mockImplementation((mutator) => {
			const nextState = mutator(structuredClone(runtimeState));

			return Promise.resolve(nextState);
		});
		vi.spyOn(internals, 'checkPortHealth').mockResolvedValue(true);
		vi.spyOn(internals, 'startHealthCheck').mockImplementation(() => {});

		Object.assign(internals, {
			addressInUsePort: 47821,
			process: null,
			restartRequested: false,
			shutDownDeliberately: false
		});

		internals.onExit(1, null);
		await flushPromises();

		expect(onPortDetected).toHaveBeenCalledWith(47821);
		expect(onStatusChange).toHaveBeenCalledWith('running');
		expect(onStatusChange).not.toHaveBeenCalledWith('error');
	});
});
