import { DEFAULT_KEY_FIX_ENABLED, type RuntimeState, type TunnelState } from '@ungate/shared/frontend';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { TestHelper } from './helpers/test-helper';

import type { ExtensionController as ExtensionControllerType } from '../../src/extension-controller';

interface MockApiServer {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	restart: ReturnType<typeof vi.fn>;
	getPort: ReturnType<typeof vi.fn>;
	syncLeaderHealthMonitor: ReturnType<typeof vi.fn>;
}

interface MockTunnelManager {
	stop: ReturnType<typeof vi.fn>;
}

interface MockDashboard {
	setPort: ReturnType<typeof vi.fn>;
	sendTunnelState: ReturnType<typeof vi.fn>;
	pushLog: ReturnType<typeof vi.fn>;
	sendKeyFixState: ReturnType<typeof vi.fn>;
	show: ReturnType<typeof vi.fn>;
}

interface ExtensionControllerInternals {
	currentPort: number | null;
	syncFromRuntimeState(): Promise<void>;
}

const createOutputChannelMock = vi.fn(() => {
	return {
		appendLine: vi.fn(),
		dispose: vi.fn()
	};
});
const createStatusBarItemMock = vi.fn(() => {
	return {
		command: '',
		text: '',
		tooltip: '',
		show: vi.fn(),
		dispose: vi.fn()
	};
});
const registerCommandMock = vi.fn(() => {
	return {
		dispose: vi.fn()
	};
});

const runtimeReadMock = vi.fn<() => RuntimeState>();
const runtimeHasLiveClientsMock = vi.fn<(state: RuntimeState) => boolean>();
const runtimeGetLiveClientIdsMock = vi.fn<(state: RuntimeState) => string[]>();
const runtimeTouchClientMock = vi.fn<(windowId: string) => Promise<RuntimeState>>();
const runtimeRemoveClientMock = vi.fn<(windowId: string) => Promise<RuntimeState>>();
const runtimeGetLeaderWindowIdMock = vi.fn<(state: RuntimeState) => string | null>();
const runtimePeekCommandMock = vi.fn<() => null>();

const apiServerStartMock = vi.fn().mockResolvedValue(undefined);
const apiServerStopMock = vi.fn().mockResolvedValue(undefined);
const apiServerRestartMock = vi.fn().mockResolvedValue(undefined);
const apiServerGetPortMock = vi.fn().mockReturnValue(null);
const apiServerSyncLeaderHealthMonitorMock = vi.fn();

vi.mock('vscode', () => {
	return {
		window: {
			createOutputChannel: createOutputChannelMock,
			createStatusBarItem: createStatusBarItemMock
		},
		commands: {
			registerCommand: registerCommandMock
		},
		StatusBarAlignment: {
			Right: 1
		},
		MarkdownString: TestHelper.createMarkdownStringClass()
	};
});

vi.mock('../../src/runtime-state', () => {
	return {
		RuntimeStateStore: {
			read: runtimeReadMock,
			hasLiveClients: runtimeHasLiveClientsMock,
			getLiveClientIds: runtimeGetLiveClientIdsMock,
			touchClient: runtimeTouchClientMock,
			removeClient: runtimeRemoveClientMock,
			getLeaderWindowId: runtimeGetLeaderWindowIdMock,
			peekCommand: runtimePeekCommandMock
		}
	};
});

vi.mock('../../src/dashboard', () => {
	return {
		Dashboard: class {
			sendKeyFixState = vi.fn();
			pushLog = vi.fn();
			setPort = vi.fn();
			sendTunnelState = vi.fn();
			show = vi.fn();
		}
	};
});

vi.mock('../../src/openai-key-fix', () => {
	return {
		OpenAiKeyFix: class {
			activate(): Promise<void> {
				return Promise.resolve();
			}

			applySharedState(): Promise<void> {
				return Promise.resolve();
			}

			isEnabled(): boolean {
				return true;
			}

			stop(): void {}
		}
	};
});

vi.mock('../../src/tunnel-manager', () => {
	return {
		TunnelManager: class {
			stop = vi.fn();
		}
	};
});

vi.mock('../../src/api-server', () => {
	return {
		ApiServer: class {
			start = apiServerStartMock;
			stop = apiServerStopMock;
			restart = apiServerRestartMock;
			getPort = apiServerGetPortMock;
			syncLeaderHealthMonitor = apiServerSyncLeaderHealthMonitorMock;
		}
	};
});

let ExtensionController: typeof import('../../src/extension-controller').ExtensionController;

function createRuntimeState(windowIds: string[], apiPort: number | null = 4783): RuntimeState {
	const runtimeState = TestHelper.createRuntimeState(windowIds, apiPort);

	return runtimeState;
}

function createContext() {
	return {
		subscriptions: [],
		extensionPath: '/tmp/ungate-extension'
	};
}

function createController(windowId: string): {
	controller: ExtensionControllerType;
	apiServer: MockApiServer;
	tunnelManager: MockTunnelManager;
	dashboard: MockDashboard;
	statusBar: { text: string; tooltip: string; show: ReturnType<typeof vi.fn> };
} {
	const controller = new ExtensionController(createContext() as never);
	const apiServer: MockApiServer = {
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		restart: vi.fn().mockResolvedValue(undefined),
		getPort: vi.fn().mockReturnValue(null),
		syncLeaderHealthMonitor: vi.fn()
	};
	const tunnelManager: MockTunnelManager = {
		stop: vi.fn()
	};
	const dashboard: MockDashboard = {
		setPort: vi.fn(),
		sendTunnelState: vi.fn(),
		pushLog: vi.fn(),
		sendKeyFixState: vi.fn(),
		show: vi.fn()
	};
	const statusBar = {
		text: '',
		tooltip: '',
		show: vi.fn()
	};
	const currentTunnelState: TunnelState = {
		status: 'stopped',
		url: null,
		error: null
	};
	let keyFixEnabled = DEFAULT_KEY_FIX_ENABLED;
	const applySharedStateMock = vi.fn((enabled: boolean) => {
		keyFixEnabled = enabled;
	});

	Object.assign(controller as object, {
		windowId,
		apiServer,
		tunnelManager,
		dashboard,
		statusBar,
		keyFix: {
			isEnabled() {
				return keyFixEnabled;
			},
			applySharedState: applySharedStateMock,
			stop() {}
		},
		currentTunnelState,
		currentPort: null,
		lastApiStatus: null,
		extensionHostActive: true,
		heartbeatTimer: null,
		syncTimer: null
	});

	return { controller, apiServer, tunnelManager, dashboard, statusBar };
}

function getInternals(controller: ExtensionControllerType): ExtensionControllerInternals {
	return controller as unknown as ExtensionControllerInternals;
}

describe('ExtensionController', () => {
	beforeAll(async () => {
		const module = await import('../../src/extension-controller');
		ExtensionController = module.ExtensionController;
	});

	beforeEach(() => {
		createOutputChannelMock.mockClear();
		createStatusBarItemMock.mockClear();
		registerCommandMock.mockClear();
		runtimeReadMock.mockReset();
		runtimeHasLiveClientsMock.mockReset();
		runtimeGetLiveClientIdsMock.mockReset();
		runtimeTouchClientMock.mockReset();
		runtimeRemoveClientMock.mockReset();
		runtimeRemoveClientMock.mockResolvedValue(createRuntimeState([], null));
		runtimeGetLeaderWindowIdMock.mockReset();
		runtimePeekCommandMock.mockReset();
		runtimePeekCommandMock.mockReturnValue(null);
		apiServerStartMock.mockClear();
		apiServerStopMock.mockClear();
		apiServerRestartMock.mockClear();
		apiServerGetPortMock.mockClear();
		apiServerSyncLeaderHealthMonitorMock.mockClear();
		apiServerGetPortMock.mockReturnValue(null);
		apiServerStartMock.mockResolvedValue(undefined);
	});

	it('starts the api on activate bootstrap when leader has no port', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		Object.assign(controller as object, {
			startHeartbeat: vi.fn(),
			startRuntimeSync: vi.fn()
		});

		controller.activate();

		await vi.waitFor(() => {
			expect(apiServerStartMock).toHaveBeenCalledTimes(1);
		});
	});

	it('bootstraps runtime sync immediately on activate', async () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeTouchClientMock.mockResolvedValue(runtimeState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		Object.assign(controller as object, {
			startHeartbeat: vi.fn(),
			startRuntimeSync: vi.fn()
		});

		controller.activate();

		await vi.waitFor(() => {
			expect(apiServerStartMock).toHaveBeenCalledTimes(1);
			expect(runtimeTouchClientMock).not.toHaveBeenCalled();
		});
	});

	it('does not stop api when current window is not leader', () => {
		const { controller, apiServer, tunnelManager } = createController('window-b');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		controller.stopBackendServices();

		expect(apiServer.stop).not.toHaveBeenCalled();
		expect(tunnelManager.stop).not.toHaveBeenCalled();
	});

	it('stops api when current window is leader', () => {
		const { controller, apiServer } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(true);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		controller.stopBackendServices();

		expect(apiServer.stop).toHaveBeenCalledTimes(1);
	});

	it('stops tunnel when no live clients remain', () => {
		const { controller, tunnelManager } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		controller.stopBackendServices();

		expect(tunnelManager.stop).toHaveBeenCalledTimes(1);
	});

	it('removes the current client from runtime state during shutdown', () => {
		const { controller } = createController('window-a');
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeHasLiveClientsMock.mockReturnValue(false);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		runtimeRemoveClientMock.mockResolvedValue(createRuntimeState([], null));

		controller.stopBackendServices();

		expect(runtimeRemoveClientMock).toHaveBeenCalledWith('window-a');
	});

	it('touches the current client when it is missing from live clients', async () => {
		const { controller, apiServer } = createController('window-b');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a']);
		const touchedState = createRuntimeState(['window-a', 'window-b']);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockImplementation((state) => {
			return Object.keys(state.clients);
		});
		runtimeTouchClientMock.mockResolvedValue(touchedState);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');

		await internals.syncFromRuntimeState();

		expect(runtimeTouchClientMock).toHaveBeenCalledWith('window-b');
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(false);
	});

	it('starts the api when the current window is the leader and no local port exists', async () => {
		const { controller, apiServer } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(null);

		await internals.syncFromRuntimeState();

		expect(apiServer.start).toHaveBeenCalledTimes(1);
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(true);
	});

	it('does not start the api when the current window is not the leader', async () => {
		const { controller, apiServer } = createController('window-b');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a', 'window-b'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a', 'window-b']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(null);

		await internals.syncFromRuntimeState();

		expect(apiServer.start).not.toHaveBeenCalled();
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(false);
	});

	it('does not start the api when the leader already has a local port', async () => {
		const { controller, apiServer } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], 4783);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(4783);

		await internals.syncFromRuntimeState();

		expect(apiServer.start).not.toHaveBeenCalled();
		expect(apiServer.syncLeaderHealthMonitor).toHaveBeenCalledWith(true);
	});

	it('applies shared key-fix state during runtime sync', async () => {
		const { controller, dashboard } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeState.keyFix.enabled = !DEFAULT_KEY_FIX_ENABLED;
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		const keyFix = (controller as unknown as { keyFix: { applySharedState: ReturnType<typeof vi.fn> } }).keyFix;

		await internals.syncFromRuntimeState();

		expect(keyFix.applySharedState).toHaveBeenCalledWith(!DEFAULT_KEY_FIX_ENABLED);
		expect(dashboard.sendKeyFixState).toHaveBeenCalledWith(!DEFAULT_KEY_FIX_ENABLED);
	});

	it('keeps the known local port when runtime state regresses to null', async () => {
		const { controller, apiServer, dashboard } = createController('window-a');
		const internals = getInternals(controller);
		const runtimeState = createRuntimeState(['window-a'], null);
		runtimeReadMock.mockReturnValue(runtimeState);
		runtimeGetLiveClientIdsMock.mockReturnValue(['window-a']);
		runtimeGetLeaderWindowIdMock.mockReturnValue('window-a');
		apiServer.getPort.mockReturnValue(4783);

		internals.currentPort = 4783;

		await internals.syncFromRuntimeState();

		expect(dashboard.setPort).toHaveBeenCalledWith(4783);
		expect(internals.currentPort).toBe(4783);
	});
});
