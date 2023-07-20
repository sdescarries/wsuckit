import { serve } from "https://deno.land/std@0.192.0/http/mod.ts";
import { createClient, RedisClientType } from 'npm:redis@4.6.7';

const redisClient: RedisClientType = createClient({ url: 'redis://localhost' });

const onRedisError = (err: Error) => console.error(`redisClient: ${err.stack}`);
redisClient.on('error', onRedisError);
redisClient.on('connect', () => console.log('redisClient: connect'));
redisClient.on('ready', () => console.log('redisClient: ready'));
redisClient.on('end', () => console.log('redisClient: end'));
redisClient.on('reconnecting', () => console.log('redisClient: reconnecting'));

await redisClient.connect();

const multi = new Map<string, MultiCaster>();

const listener = (message: string, channel: string) =>
  multi.get(channel)?.connections?.forEach(con => con.send(message));

class MultiCaster {
  channel: string;
  connections = new Set<Connection>();
  sub: RedisClientType;

  constructor(channel: string) {
    this.channel = channel;

    const sub = this.sub = redisClient.duplicate();
    sub.on('error', onRedisError);
    sub
      .connect()
      .then(() => sub.subscribe(channel, listener))
      .catch(onRedisError);
  }

  static register(con: Connection) {
    console.log(`[${con.channel}] register`);
    let caster = multi.get(con.channel);
    if (caster == null) {
      caster = new MultiCaster(con.channel);
      multi.set(con.channel, caster);
      console.log(`[${con.channel}] new channel`);
    }
    caster.add(con);
  }

  static unregister(con: Connection) {
    console.log(`[${con.channel}] unregister`);
    const caster = multi.get(con.channel);
    if (caster == null) {
      return;
    }
    caster.rem(con);
  }

  add(con: Connection) {
    console.log(`[${this.channel}] add listener`);
    this.connections.add(con);
  }

  rem(con: Connection) {
    console.log(`[${this.channel}] rem listener`);
    this.connections.delete(con);

    if (this.connections.size === 0) {
      console.log(`[${this.channel}] drop channel`);
      this.sub.unsubscribe(this.channel);
      this.sub.quit();
      multi.delete(this.channel);
    }
  }
}

interface ConnectionParams {
  channel: string;
  request: Request;
  socket: WebSocket;
}

class Connection implements ConnectionParams {

  client: string;
  channel: string;
  request: Request;
  socket: WebSocket;

  constructor(params: ConnectionParams) {
    this.channel = params.channel;
    this.request = params.request;
    this.socket = params.socket;
    this.client = this.request.headers.get('host') ?? 'unknown';

    this.socket.onopen = (ev: Event) => this.open(ev);
    this.socket.onmessage = (ev: MessageEvent) => this.message(ev);
    this.socket.onclose = (ev: CloseEvent) => this.close(ev);
    this.socket.onerror = (ev: Event | ErrorEvent) => this.error(ev);
  }

  send(message: string) {
    console.log(`send ${message}`);
    this.socket.send(message);
  }

  open(_ev: Event): void {
    console.log(`open ${this.channel} ${this.client}`);
    MultiCaster.register(this);
  }

  close(_ev: CloseEvent): void {
    console.log(`close`);
    MultiCaster.unregister(this);
  }

  message(ev: MessageEvent): void {
    if (ev.data === 'ping') {
      console.log(`[${this.channel}] recv ${ev.data}`);
      redisClient
        .publish(this.channel, ev.data)
        .catch(console.error);
    }

    if (ev.data === 'close') {
      this.socket.close();
    }
  }

  error(ev: Error | Event | ErrorEvent): void {

    const detail: string[] = ['Error'];

    if (ev instanceof Event) {
      detail.push(ev.type);
    }

    if (ev instanceof ErrorEvent) {
      detail.push(ev.message);
    }

    if (ev instanceof Error) {
      detail.push(ev.message);
    }

    const reason = detail.join(': ');
    console.error(reason);

    if (this.socket.OPEN) {
      this.socket.close(1002, reason);
    }
  }
}


async function reqHandler(request: Request) {

  const url = new URL(request.url);

  if (request.headers.get("upgrade") != "websocket") {

    if (url.pathname === 'favicon.ico') {
      return new Response('');
    }

    const template = await Deno.readTextFile('./ws.html');
    return new Response(template, { headers: { 'Content-Type': 'text/html' }});
  }

  const channel = url.pathname;

  console.log(`WS Upgrade ${channel}`);

  const { socket, response } = Deno.upgradeWebSocket(request);
  new Connection({ socket, channel, request });

  return response;
}

const port = parseInt(Deno.args[0] ?? '8000', 10);

serve(reqHandler, { port });
