import { randomBytes } from 'node:crypto';
import * as ed from '@noble/ed25519';
import WebSocket from 'ws';

const API_URL = (process.env.PERPL_API_URL ?? 'https://app.perpl.xyz/api').replace(/\/$/, '');
const WS_URL = (process.env.PERPL_WS_URL ?? 'wss://app.perpl.xyz').replace(/\/$/, '');
const CHAIN_ID = Number(process.env.PERPL_CHAIN_ID ?? 143);
const configuredAccountId = process.env.PERPL_ACCOUNT_ID ? Number(process.env.PERPL_ACCOUNT_ID) : null;

type Json = Record<string, unknown>;
type Account = { mt?: number; in?: number; id?: number; fr?: boolean; fw?: boolean; ft?: number; lfr?: number; b?: string; lb?: string; h?: Json[] };
type State = { walletAddress: string | null; accounts: Account[]; account: Account | null; orders: Json[]; positions: Json[]; headBlock: number | null; sequence: number | null; updatedAt: number };
type OrderInput = { mkt: number; t: number; s: number; lv: number; fl: number; p?: number; a?: string; ms?: number; tif?: number; tp?: number; tpc?: number; tr?: number; lp?: number; bf?: number };

function requireConfig() {
  const apiKey = process.env.PERPL_API_KEY?.trim();
  const secret = process.env.PERPL_API_PRIVATE_KEY?.trim() || process.env.PERPL_API_KEY_SECRET?.trim();
  if (!apiKey) throw new Error('Missing PERPL_API_KEY');
  if (!secret) throw new Error('Missing PERPL_API_PRIVATE_KEY');
  return { apiKey, privateKey: decodePrivateKey(secret) };
}

function decodePrivateKey(value: string): Uint8Array {
  const normalized = value.trim().replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(normalized)) return new Uint8Array(Buffer.from(normalized, 'hex'));
  try {
    const bytes = new Uint8Array(Buffer.from(value, 'base64url'));
    if (bytes.length === 32) return bytes;
  } catch {}
  throw new Error('PERPL_API_PRIVATE_KEY must be a 32-byte Ed25519 private key in hex or base64url form');
}

function object(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
}
function array(value: unknown): Json[] { return Array.isArray(value) ? value.filter((item): item is Json => !!object(item)) : []; }
function numeric(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function decimalString(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function ordersFrom(value: unknown): Json[] {
  if (Array.isArray(value)) return array(value);
  const source = object(value);
  if (!source) return [];
  for (const key of ['orders', 'data', 'items']) {
    if (Array.isArray(source[key])) return array(source[key]);
  }
  return [];
}

export class PerplClient {
  private ws?: WebSocket;
  private requestId = 0;
  private sequenceId = 0;
  private state: State = { walletAddress: null, accounts: [], account: null, orders: [], positions: [], headBlock: null, sequence: null, updatedAt: 0 };
  private buffer: Json[] = [];
  private listeners = new Set<(message: Json) => void>();
  private connectPromise: Promise<void> | null = null;
  private commandTail: Promise<void> = Promise.resolve();

  async getMarkets(): Promise<unknown> {
    const response = await fetch(`${API_URL}/v1/pub/context`);
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`Perpl market context ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
  }

  async getMarketCandles(marketId: number, resolutionSeconds: number, fromMs: number, toMs: number): Promise<unknown> {
    if (!Number.isInteger(marketId) || marketId <= 0) throw new Error('Invalid Perpl market id');
    if (!Number.isInteger(resolutionSeconds) || resolutionSeconds <= 0) throw new Error('Invalid Perpl candle resolution');
    if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs < 0 || toMs <= fromMs) throw new Error('Invalid Perpl candle time range');
    if (toMs - fromMs > 1024 * resolutionSeconds * 1000) throw new Error('Perpl candle request exceeds the 1024-candle limit');
    const response = await fetch(`${API_URL}/v1/market-data/${marketId}/candles/${resolutionSeconds}/${fromMs}-${toMs}`);
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`Perpl candle data ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
  }

  async getFunding(marketId: number, fromMs: number, toMs: number): Promise<unknown> {
    if (!Number.isInteger(marketId) || marketId <= 0) throw new Error('Invalid Perpl market id');
    if (!Number.isInteger(fromMs) || !Number.isInteger(toMs) || fromMs < 0 || toMs <= fromMs) throw new Error('Invalid Perpl funding time range');
    const response = await fetch(`${API_URL}/v1/market-data/${marketId}/funding/${fromMs}-${toMs}`);
    const text = await response.text();
    let body: unknown;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(`Perpl funding ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    return body;
  }

  async getState(): Promise<unknown> {
    await this.connect(true);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      if (this.ready()) return this.publicState();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Perpl trading state did not become ready after authentication');
  }

  async placeOrder(input: OrderInput): Promise<unknown> {
    return this.withCommandLock(async () => {
      await this.ensureReady();
      const accountId = this.accountId();
      const market = await this.getMarket(input.mkt);
      const head = this.state.headBlock ?? 0;
      const lb = head > 0 ? head + Number(market?.order_ttl_blocks ?? 0) : 0;
      const rq = Math.max(this.requestId + 1, this.state.account?.lfr ? this.state.account.lfr + 1 : 0, Date.now());
      this.requestId = rq;
      const sn = ++this.sequenceId;
      return this.sendOrder({ ...input, acc: accountId, rq, sn, lb });
    });
  }

  async cancelOrder(mkt: number, oid: number): Promise<unknown> {
    return this.withCommandLock(async () => {
      await this.ensureReady();
      const rq = Math.max(this.requestId + 1, this.state.account?.lfr ? this.state.account.lfr + 1 : 0, Date.now());
      this.requestId = rq;
      const sn = ++this.sequenceId;
      return this.sendOrder({ mkt, acc: this.accountId(), oid, t: 5, p: 0, s: 0, fl: 0, lv: 0, lb: 0, rq, sn });
    });
  }

  private async getMarket(mkt: number): Promise<any> {
    const context: any = await this.getMarkets();
    return Array.isArray(context?.markets) ? context.markets.find((item: any) => Number(item?.id) === mkt) : undefined;
  }

  private accountId(): number {
    const id = numeric(this.state.account?.id);
    if (id === null) throw new Error('Perpl authenticated wallet has no exchange account');
    if (this.state.account?.fr === true) throw new Error('Perpl account is frozen; refusing to place API order');
    if (this.state.account?.fw === false) throw new Error('Perpl account forwarding is disabled; API orders will be rejected');
    return id;
  }

  private ready() { return !!this.state.account && this.state.headBlock !== null && this.state.sequence !== null; }

  private availableBalance(account: Account | null): string | null {
    const balance = decimalString(account?.b);
    const locked = decimalString(account?.lb);
    if (balance === null) return null;
    if (locked === null) return balance;
    try { return (Number(balance) - Number(locked)).toString(); } catch { return balance; }
  }

  private selectAccount(accounts: Account[]): Account | null {
    if (!accounts.length) return null;
    if (configuredAccountId !== null && Number.isFinite(configuredAccountId)) {
      return accounts.find((item) => Number(item.id) === configuredAccountId) ?? null;
    }
    return accounts.length === 1 ? accounts[0] : accounts.find((item) => decimalString(item.b) !== '0') ?? accounts[0];
  }

  private publicState() {
    const account = this.state.account;
    const accountSummaries = this.state.accounts.map((item) => ({
      instance_id: item.in ?? null,
      account_id: item.id ?? null,
      balance: item.b ?? null,
      locked_balance: item.lb ?? null,
      available_balance: this.availableBalance(item),
      frozen: item.fr ?? null,
      forwarding: item.fw ?? null,
      fee_tier: item.ft ?? null,
      last_forwarded_request_id: item.lfr ?? null,
    }));
    return {
      status: this.ready() ? 'ok' : 'connecting',
      trading_available: this.ready() && account?.fr !== true && account?.fw !== false,
      connector: 'perpl-direct',
      wallet_address: this.state.walletAddress,
      selected_account_id: account?.id ?? null,
      configured_account_id: configuredAccountId,
      account: account,
      accounts: accountSummaries,
      balance: account?.b ?? null,
      locked_balance: account?.lb ?? null,
      available_balance: this.availableBalance(account),
      orders: this.state.orders,
      order_count: this.state.orders.length,
      positions: this.state.positions,
      head_block: this.state.headBlock,
      stale: !this.state.updatedAt || Date.now() - this.state.updatedAt > 5000,
      sequence_gap: false,
      last_message_at: this.state.updatedAt ? new Date(this.state.updatedAt).toISOString() : null,
    };
  }

  private async ensureReady() { await this.connect(); if (!this.ready()) await this.getState(); if (!this.ready()) throw new Error('Perpl trading state is unavailable'); }

  private async connect(forceRefresh = false) {
    if (forceRefresh && this.ws?.readyState === WebSocket.OPEN) {
      const oldWs = this.ws;
      try { oldWs.close(); } catch {}
      if (this.ws === oldWs) this.ws = undefined;
      this.state = { walletAddress: null, accounts: [], account: null, orders: [], positions: [], headBlock: null, sequence: null, updatedAt: 0 };
      this.buffer = [];
    }
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openSocket();
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  private async openSocket() {
    const { apiKey, privateKey } = requireConfig();
    const ws = new WebSocket(`${WS_URL}/ws/v1/trading`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let gotWalletSnapshot = false;
      let gotOrdersSnapshot = false;
      let gotPositionsSnapshot = false;
      const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); fn(); };
      const timeout = setTimeout(() => finish(() => reject(new Error('Perpl trading WebSocket snapshots timeout'))), 6000);
      ws.once('open', async () => {
        try {
          const timestamp = Date.now().toString();
          const nonce = randomBytes(16).toString('base64url');
          const canonical = [CHAIN_ID, 'trading-ws-signin', timestamp, nonce].join('\n');
          const signature = await ed.signAsync(Buffer.from(canonical), privateKey);
          ws.send(JSON.stringify({ mt: 29, chain_id: CHAIN_ID, api_key: apiKey, timestamp, nonce, signature: Buffer.from(signature).toString('base64url') }));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
      });
      ws.on('message', (raw) => {
        let message: Json;
        try { message = JSON.parse(raw.toString()) as Json; } catch { return; }
        this.consume(message);
        const mt = Number(message.mt);
        if (mt === 19) gotWalletSnapshot = true;
        else if (mt === 23) gotOrdersSnapshot = true;
        else if (mt === 26) gotPositionsSnapshot = true;
        if (gotWalletSnapshot && gotOrdersSnapshot && gotPositionsSnapshot) finish(resolve);
      });
      ws.once('error', (error) => finish(() => reject(error)));
      ws.once('close', () => { if (this.ws === ws) this.ws = undefined; if (!settled) finish(() => reject(new Error('Perpl trading WebSocket closed before snapshots completed'))); });
    });
  }

  private consume(message: Json) {
    this.state.updatedAt = Date.now();
    if (Number(message.mt) === 19) {
      this.state.walletAddress = typeof message.addr === 'string' ? message.addr : null;
      const accounts = array(message.as).map((item) => item as Account);
      this.state.accounts = accounts;
      this.state.account = this.selectAccount(accounts);
      if (this.state.account) {
        const lfr = numeric(this.state.account.lfr);
        if (lfr !== null) this.requestId = Math.max(this.requestId, lfr);
      }
      this.state.sequence = numeric(message.sn);
    } else if (Number(message.mt) === 20 || Number(message.mt) === 21) {
      const account = object(message.d) as Account | null;
      if (account) {
        const next = this.state.accounts.map((item) => Number(item.id) === Number(account.id) ? { ...item, ...account } : item);
        this.state.accounts = next.some((item) => Number(item.id) === Number(account.id)) ? next : [...next, account];
        this.state.account = this.selectAccount(this.state.accounts);
      }
      const lfr = numeric(account?.lfr);
      if (lfr !== null) this.requestId = Math.max(this.requestId, lfr);
    } else if (Number(message.mt) === 23) this.state.orders = ordersFrom(message.d);
    else if (Number(message.mt) === 24) {
      for (const item of ordersFrom(message.d)) this.applyUpdate(this.state.orders, item);
    }
    else if (Number(message.mt) === 26) this.state.positions = array(message.d);
    else if (Number(message.mt) === 27) { const items = array(message.d); for (const item of items) this.applyUpdate(this.state.positions, item); }
    else if (Number(message.mt) === 100) {
      const sequence = numeric(message.sn);
      const head = numeric(message.h);
      if (sequence !== null && this.state.sequence !== null && sequence !== this.state.sequence + 1) {
        this.state.walletAddress = null; this.state.accounts = []; this.state.account = null; this.state.orders = []; this.state.positions = []; this.state.headBlock = null; this.state.sequence = null;
      } else if (sequence !== null) this.state.sequence = sequence;
      if (head !== null) this.state.headBlock = head;
    }
    if (this.listeners.size) for (const listener of this.listeners) listener(message);
    else { this.buffer.push(message); if (this.buffer.length > 250) this.buffer.shift(); }
  }

  private applyUpdate(target: Json[], update: Json) {
    const key = ['oid', 'id', 'pid', 'position_id'].find((field) => update[field] !== undefined);
    if (!key) { target.push(update); return; }
    const value = String(update[key]);
    const index = target.findIndex((item) => String(item[key]) === value);
    if (update.r === true) { if (index >= 0) target.splice(index, 1); return; }
    if (index >= 0) target[index] = update; else target.push(update);
  }

  private orderFromMessage(message: Json, rq: number): Json | null {
    const matches = [message, ...ordersFrom(message.d)].filter((item) => Number(item.rq) === rq);
    return matches.length ? matches[matches.length - 1] : null;
  }

  private async sendOrder(order: Json): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Perpl trading WebSocket is not open');
    return new Promise((resolve, reject) => {
      const sn = Number(order.sn); const rq = Number(order.rq);
      let settled = false;
      const finishReject = (error: Error) => { if (settled) return; settled = true; clearTimeout(timeout); unsubscribe(); reject(error); };
      const finishResolve = (value: unknown) => { if (settled) return; settled = true; clearTimeout(timeout); unsubscribe(); resolve(value); };
      const timeout = setTimeout(() => finishReject(new Error(`Perpl order response timeout (sn=${sn}, rq=${rq})`)), 10000);
      const unsubscribe = this.onMessage((message) => {
        if (Number(message.mt) === 3 && Number(message.cid) === sn) {
          const status = object(message.status);
          const code = numeric(status?.code);
          if (code !== 0) {
            finishReject(new Error(`Perpl order gateway rejected (code=${code ?? 'unknown'}): ${String(status?.error ?? 'unknown error')}`));
          }
          return;
        }
        if (Number(message.mt) !== 24) return;
        const orderUpdate = this.orderFromMessage(message, rq);
        if (!orderUpdate) return;
        const status = numeric(orderUpdate.st);
        if (status === 7) {
          const reason = orderUpdate.sr ?? orderUpdate.fr ?? 'unknown order failure';
          finishReject(new Error(`Perpl order failed (sr=${String(reason)})`));
          return;
        }
        if (status !== null && [2, 3, 4, 5, 8, 9, 10].includes(status)) {
          finishResolve(orderUpdate);
        }
      });
      try {
        ws.send(JSON.stringify({ ...order, mt: 22 }));
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(listener: (message: Json) => void) {
    this.listeners.add(listener);
    if (this.buffer.length) { const messages = this.buffer.splice(0, this.buffer.length); for (const message of messages) listener(message); }
    return () => this.listeners.delete(listener);
  }

  private withCommandLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.commandTail.then(operation, operation);
    this.commandTail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export const perpl = new PerplClient();