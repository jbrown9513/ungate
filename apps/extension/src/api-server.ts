import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

import { sleep, type ApiStatus as ServerStatus, type LogEntry } from '@ungate/shared';
import * as vscode from 'vscode';

import { RuntimeStateStore } from './runtime-state';
import { config } from './runtime-state/config';
import { NodeResolver } from './utils/node-resolver';

import type { Writable } from 'node:stream';

const HEALTH_CHECK_URL = (port: number) => `http://localhost:${port}/health`;
const BETTER_SQLITE3_VERSION = '12.9.0';

interface ApiServerCallbacks {
	onLog(level: LogEntry['level'], message: string): void;
	onPortDetected(port: number): void;
	onStatusChange(status: ServerStatus): void;
	isLeaderWindow(): boolean;
	isExtensionHostActive(): boolean;
}

export class ApiServer {
	private process: cp.ChildProcess | null = null;
	private healthCheckTimer: NodeJS.Timeout | null = null;
	private stdoutBuffer = '';
	private restartRequested = false;
	private shutDownDeliberately = false;
	private lastStatus: ServerStatus | null = null;
	private port: number | null = null;
	private runtimePath = '';
	private noClientsSince: number | null = null;
	private addressInUsePort: number | null = null;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly callbacks: ApiServerCallbacks
	) {}

	async start(): Promise<void> {
		if (this.process) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		const existingPort = runtimeState.api.port;

		if (existingPort) {
			const isAlive = await this.checkPortHealth(existingPort);

			if (isAlive) {
				this.port = existingPort;
				this.callbacks.onPortDetected(existingPort);
				await this.setStatus('running');
				this.startHealthCheck();

				return;
			}
		}

		await this.ensureNativeDeps();
		this.spawn();
	}

	async restart(): Promise<void> {
		this.restartRequested = true;
		await this.setStatus('stopped');

		if (!this.process) {
			await sleep(0);
			this.spawn();

			return;
		}

		this.process.kill();
	}

	async stop(): Promise<void> {
		this.stopHealthCheck();
		if (this.process) {
			this.shutDownDeliberately = true;
		}
		this.process?.kill();
		this.process = null;
		this.noClientsSince = null;
		this.lastStatus = 'stopped';
		await this.writeRuntimeState('stopped', null);
	}

	getPort(): number | null {
		return this.port;
	}

	syncLeaderHealthMonitor(isLeader: boolean): void {
		if (!isLeader) {
			this.stopHealthCheck();

			return;
		}

		const hasRuntimeTarget = this.process !== null || this.port !== null;

		if (hasRuntimeTarget && !this.healthCheckTimer) {
			this.startHealthCheck();
		}
	}

	private spawn(): void {
		const cwd = this.getServerCwd();
		this.stdoutBuffer = '';

		const isDev = this.context.extensionMode === vscode.ExtensionMode.Development;
		const runtime = this.runtimePath || this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			...(isDev ? { DB_PATH: path.join(os.homedir(), '.ungate', 'data-dev.db') } : { DRIZZLE_PATH: path.join(cwd, 'drizzle') })
		};

		const nodeArgs = isDev ? ['-r', 'source-map-support/register', 'dist/main.js'] : ['bundle/main.cjs'];

		this.callbacks.onLog('info', `[process] starting api via ${runtime}`);

		this.process = cp.spawn(runtime, nodeArgs, { cwd, env, stdio: 'pipe', detached: true });
		this.process.unref();
		void this.writeRuntimeState('stopped', null).catch(() => {});

		this.process.stdout?.on('data', (data: Buffer) => this.onStdout(data));
		this.process.stderr?.on('data', (data: Buffer) => this.onStderr(data));
		this.process.on('exit', (code, signal) => this.onExit(code, signal));
		this.process.on('error', (err) => {
			void this.onSpawnProcessError(err).catch(() => {});
		});

		this.startHealthCheck();
	}

	private onStdout(data: Buffer): void {
		const text = data.toString();
		this.stdoutBuffer += text;

		for (const line of text.split('\n').filter((l) => l.trim())) {
			this.callbacks.onLog(this.parseLogLevel(line), line);
		}

		const match = /localhost:(\d+)/.exec(this.stdoutBuffer);

		if (match) {
			const port = parseInt(match[1], 10);

			if (port !== this.port) {
				this.port = port;
				this.callbacks.onPortDetected(port);
			}
		}
	}

	private onStderr(data: Buffer): void {
		const text = data.toString();

		for (const line of text.split('\n').filter((l) => l.trim())) {
			if (line.includes('EADDRINUSE')) {
				const match = /port:\s*(\d+)/.exec(this.stdoutBuffer + text);

				if (match) {
					this.addressInUsePort = parseInt(match[1], 10);
				}
			}

			this.callbacks.onLog('error', line);
		}
	}

	private onExit(code: number | null, signal: NodeJS.Signals | null): void {
		this.process = null;
		this.noClientsSince = null;

		let level: LogEntry['level'];

		if (this.restartRequested || code === 0) {
			level = 'info';
		} else {
			level = 'error';
		}

		this.callbacks.onLog(level, `[process] exit code=${code} signal=${signal}`);

		if (this.restartRequested) {
			this.restartRequested = false;
			this.shutDownDeliberately = false;
			this.lastStatus = 'stopped';
			void sleep(config.apiServer.restartDelayMs).then(() => {
				this.spawn();
			});

			return;
		}

		if (this.shutDownDeliberately) {
			this.shutDownDeliberately = false;

			return;
		}

		if (code === 0) {
			this.lastStatus = 'stopped';
			void sleep(config.apiServer.restartDelayMs).then(() => {
				this.spawn();
			});

			return;
		}

		if (this.addressInUsePort) {
			const addressInUsePort = this.addressInUsePort;
			this.addressInUsePort = null;
			void this.tryAttachToRunningPort(addressInUsePort).catch(() => {
				void this.setStatus('error').catch(() => {});
			});

			return;
		}

		void this.setStatus('error').catch(() => {});
	}

	private async tryAttachToRunningPort(port: number): Promise<void> {
		const isAlive = await this.checkPortHealth(port);

		if (!isAlive) {
			await this.setStatus('error');

			return;
		}

		this.port = port;
		this.callbacks.onPortDetected(port);
		await this.setStatus('running');
		this.startHealthCheck();
	}

	private async onSpawnProcessError(err: Error): Promise<void> {
		this.callbacks.onLog('error', `[process] error: ${err.message}`);
		await this.writeRuntimeState('error', err.message);
		this.lastStatus = 'error';
		this.callbacks.onStatusChange('error');
	}

	private startHealthCheck(): void {
		this.stopHealthCheck();

		this.healthCheckTimer = setInterval(() => {
			void this.runHealthCheckCycle().catch(() => {});
		}, config.apiServer.healthCheckIntervalMs);
	}

	private async runHealthCheckCycle(): Promise<void> {
		if (!this.callbacks.isLeaderWindow()) {
			return;
		}

		const runtimeState = RuntimeStateStore.read();
		const hasLiveClientsOnDisk = RuntimeStateStore.hasLiveClients(runtimeState);
		const extensionHostAlive = this.callbacks.isExtensionHostActive();
		const treatAsLiveClients = hasLiveClientsOnDisk || extensionHostAlive;
		const hasLeaderWindow = this.callbacks.isLeaderWindow();

		if (!treatAsLiveClients && this.lastStatus === 'running') {
			this.noClientsSince ??= Date.now();

			if (Date.now() - this.noClientsSince >= config.apiServer.noClientsGracePeriodMs) {
				this.callbacks.onLog('info', '[process] no live windows, stopping api');
				await this.stop();

				return;
			}
		} else {
			this.noClientsSince = null;
		}

		if (treatAsLiveClients && this.lastStatus === 'running' && !hasLeaderWindow) {
			return;
		}

		if (!this.port) {
			return;
		}

		try {
			const res = await fetch(HEALTH_CHECK_URL(this.port), {
				signal: AbortSignal.timeout(config.apiServer.healthCheckRequestTimeoutMs)
			});

			if (res.ok) {
				const wasDown = this.lastStatus !== 'running';

				await this.setStatus('running');

				if (wasDown) {
					this.callbacks.onPortDetected(this.port);
				}
			} else {
				await this.setStatus('error');
			}
		} catch {
			await this.setStatus('error');
		}
	}

	private stopHealthCheck(): void {
		if (this.healthCheckTimer) {
			clearInterval(this.healthCheckTimer);
			this.healthCheckTimer = null;
		}
	}

	private async setStatus(status: ServerStatus): Promise<void> {
		this.lastStatus = status;
		await this.writeRuntimeState(status, null);
		this.callbacks.onStatusChange(status);
	}

	private async writeRuntimeState(status: ServerStatus, errorMessage: string | null): Promise<void> {
		await RuntimeStateStore.mutate((current) => {
			const now = Date.now();
			let pid: number | null = null;

			if (this.process?.pid) {
				pid = this.process.pid;
			}

			current.api.pid = pid;
			current.api.port = this.port;
			current.api.status = status;
			current.api.lastSeenAt = now;
			current.api.lastError = errorMessage;

			return current;
		});
	}

	private async checkPortHealth(port: number): Promise<boolean> {
		try {
			const response = await fetch(HEALTH_CHECK_URL(port), {
				signal: AbortSignal.timeout(config.apiServer.portHealthRequestTimeoutMs)
			});

			return response.ok;
		} catch {
			return false;
		}
	}

	private isProcessAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);

			return true;
		} catch {
			return false;
		}
	}

	private getServerCwd(): string {
		if (this.context.extensionMode === vscode.ExtensionMode.Development) {
			return path.join(this.context.extensionPath, '..', 'api');
		}

		return path.join(this.context.extensionPath, 'bundled', 'api');
	}

	private parseLogLevel(line: string): LogEntry['level'] {
		const lower = line.toLowerCase();

		if (lower.includes('error') || lower.includes('fatal')) {
			return 'error';
		}

		if (lower.includes('warn')) {
			return 'warn';
		}

		return 'info';
	}

	private async ensureNativeDeps(): Promise<void> {
		const apiDir = this.getServerCwd();
		const runtime = this.resolveRuntimePath(NodeResolver.resolve(process.env.UNGATE_NODE_BIN));
		this.runtimePath = runtime;
		const isLoadableBeforeInstall = await this.canLoadBetterSqlite3(runtime, apiDir);

		if (isLoadableBeforeInstall) {
			return;
		}
		const sqliteDir = fs.realpathSync(path.join(apiDir, 'node_modules', 'better-sqlite3'));
		const binaryPath = path.join(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

		if (fs.existsSync(binaryPath)) {
			const isLoadable = await this.canLoadBetterSqlite3(runtime, apiDir);

			if (isLoadable) {
				return;
			}

			this.callbacks.onLog('warn', '[native] Existing better-sqlite3 binary is incompatible, reinstalling');
			fs.rmSync(binaryPath, { force: true });
		}

		const info = NodeResolver.inspect(runtime);
		const tarName = `better-sqlite3-v${BETTER_SQLITE3_VERSION}-node-v${info.abi}-${info.platform}-${info.arch}.tar.gz`;
		const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${BETTER_SQLITE3_VERSION}/${tarName}`;
		let installError: Error | null = null;

		this.callbacks.onLog('info', `[native] Using runtime: ${runtime}`);
		this.callbacks.onLog('info', `[native] Downloading ${tarName}...`);

		// Ensure repeated starts are idempotent when tar refuses to overwrite.
		fs.rmSync(binaryPath, { force: true });

		try {
			await this.installPrebuiltBinary(url, sqliteDir, binaryPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			installError = err instanceof Error ? err : new Error(message);

			if (message.includes('HTTP 404')) {
				this.callbacks.onLog('error', `[native] No prebuilt binary for ABI ${info.abi}`);
			} else {
				this.callbacks.onLog('error', `[native] Prebuilt install failed: ${message}`);
			}
		}

		const prebuiltLoadable = await this.canLoadBetterSqlite3(runtime, apiDir);

		if (prebuiltLoadable) {
			this.callbacks.onLog('info', '[native] better-sqlite3 binary installed');

			return;
		}

		if (installError?.message.includes('HTTP 404')) {
			throw new Error(
				`[native] No prebuilt better-sqlite3 binary for Node ABI ${info.abi} (${info.platform}-${info.arch}). ` +
					'Use Node 22 runtime (ABI 127) or set UNGATE_NODE_BIN to a supported Node binary.'
			);
		}

		const installErrorMessage = installError ? installError.message : 'unknown prebuilt install error';
		throw new Error(`[native] better-sqlite3 prebuilt installation failed: ${installErrorMessage}`);
	}

	private resolveRuntimePath(runtime: string): string {
		const inspected = cp.spawnSync(runtime, ['-p', 'process.execPath'], { encoding: 'utf8' });

		if (inspected.error || inspected.status !== 0) {
			return runtime;
		}

		const absolutePath = inspected.stdout.trim();

		if (!absolutePath) {
			return runtime;
		}

		return absolutePath;
	}

	private async installPrebuiltBinary(url: string, sqliteDir: string, binaryPath: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const extract = cp.spawn('tar', ['xzf', '-', '-C', sqliteDir], { stdio: ['pipe', 'pipe', 'pipe'] });
			const stdin = extract.stdin;

			if (!stdin) {
				reject(new Error('tar stdin is unavailable'));

				return;
			}

			extract.stderr?.on('data', (data: Buffer) => {
				this.callbacks.onLog('error', `[native] tar: ${data.toString().trim()}`);
			});

			extract.on('exit', (code) => {
				if (code === 0) {
					resolve();

					return;
				}

				if (fs.existsSync(binaryPath)) {
					this.callbacks.onLog('warn', '[native] better-sqlite3 binary already present, continuing');
					resolve();

					return;
				}

				reject(new Error(`tar exited with code ${code}`));
			});

			extract.on('error', reject);

			this.download(url, stdin, reject);
		});
	}

	private async canLoadBetterSqlite3(runtime: string, apiDir: string): Promise<boolean> {
		return await new Promise<boolean>((resolve) => {
			const child = cp.spawn(
				runtime,
				[
					'-e',
					"const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.pragma('journal_mode = WAL'); db.close();"
				],
				{
					cwd: apiDir,
					stdio: ['ignore', 'ignore', 'pipe']
				}
			);

			child.stderr?.on('data', (data: Buffer) => {
				const text = data.toString().trim();

				if (text) {
					this.callbacks.onLog('warn', `[native] ${text}`);
				}
			});

			child.on('error', () => resolve(false));
			child.on('exit', (code) => resolve(code === 0));
		});
	}

	private download(targetUrl: string, dest: Writable, reject: (err: Error) => void): void {
		https
			.get(targetUrl, { headers: { 'User-Agent': 'ungate-extension' } }, (res) => {
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					this.download(res.headers.location, dest, reject);

					return;
				}

				if (!res.statusCode || res.statusCode !== 200) {
					dest.destroy();
					reject(new Error(`Download failed: HTTP ${res.statusCode}`));

					return;
				}

				res.pipe(dest);
			})
			.on('error', (err: Error) => {
				dest.destroy();
				reject(err);
			});
	}
}
