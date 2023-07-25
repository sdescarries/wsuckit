import { serve } from "https://deno.land/std@0.192.0/http/mod.ts";
import { getCookies } from "https://deno.land/std/http/cookie.ts";
import { createClient, RedisClientType } from 'npm:redis@4.6.7';
import * as jose from 'npm:jose@4.14.4';

const redisOptions = {
  url: 'redis://localhost',
} as const;


function createRedisClient(): RedisClientType {
  const client: RedisClientType = createClient(redisOptions);
  const onRedisError = (err: Error) => console.error(`redisClient: ${err.stack}`);
  client.on('error', onRedisError);
  client.on('connect', () => console.log('redisClient: connect'));
  client.on('ready', () => console.log('redisClient: ready'));
  client.on('end', () => console.log('redisClient: end'));
  client.on('reconnecting', () => console.log('redisClient: reconnecting'));
  return client;
}

const redisClient = createRedisClient();
const multi = new Map<string, MultiCaster>();
let idx = 0;

await redisClient.connect();

const listener = (message: string, channel: string) => {
  console.log(`[${channel}] sub ${message}`);
  const send = (con: Connection) => con.send(message);

  Promise
    .resolve()
    .then(() =>
      multi.get(channel)?.connections?.forEach(send))
}

class MultiCaster {
  channel: string;
  connections = new Set<Connection>();
  sub: RedisClientType;

  constructor(channel: string) {
    this.channel = channel;

    const sub = this.sub = createRedisClient();
    sub
      .connect()
      .then(() => sub.subscribe(channel, listener));
  }

  static register(con: Connection) {
    console.log(`[${con.params.channel}] register`);
    let caster = multi.get(con.params.channel);
    if (caster == null) {
      caster = new MultiCaster(con.params.channel);
      multi.set(con.params.channel, caster);
      console.log(`[${con.params.channel}] new channel`);
    }
    caster.add(con);
  }

  static unregister(con: Connection) {
    console.log(`[${con.params.channel}] unregister`);
    const caster = multi.get(con.params.channel);
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

type Roles = 'Learner' | 'Instructor';

interface SessionInfo {
  channel: string;
  refId?: string;
  roles?: Roles[];
}

interface ConnectionParams extends SessionInfo {
  request: Request;
  socket: WebSocket;
}

class Connection {

  params: ConnectionParams;

  client: string;

  constructor(params: ConnectionParams) {
    this.params = params;
    this.client = params.request.headers.get('host') ?? 'unknown';

    this.params.socket.onopen = (ev: Event) => this.open(ev);
    this.params.socket.onmessage = (ev: MessageEvent) => this.message(ev);
    this.params.socket.onclose = (ev: CloseEvent) => this.close(ev);
    this.params.socket.onerror = (ev: Event | ErrorEvent) => this.error(ev);
  }

  send(message: string) {
    console.log(`[${this.params.channel}] send ${message}`);
    this.params.socket.send(message);

    // TODO be more selective on what to send to whom
  }

  open(_ev: Event): void {
    console.log(`[${this.params.channel}] open ${this.client}`);
    MultiCaster.register(this);

    if (!this.params.refId) {
      return;
    }

    if (this.params.roles?.includes('Learner')) {

      const message = {
        t: 'rosterActivity',
        d: {
          refId: this.params.refId,
          status: 'Joined',
        }
      }

      redisClient
        .publish(this.params.channel, JSON.stringify(message))
        .catch(console.error);
    }
  }

  close(_ev: CloseEvent): void {
    console.log(`[${this.params.channel}] close`);
    MultiCaster.unregister(this);
  }

  message(ev: MessageEvent): void {
    console.log(`[${this.params.channel}] recv ${ev.data}`);

    if (ev.data === 'ping') {

      const resp = `pong ${++idx}`;

      console.log(`[${this.params.channel}] pub ${resp}`);
      redisClient
        .publish(this.params.channel, resp)
        .catch(console.error);

      // Does not loopback reliably to the same redis client
      // listener(resp, this.params.channel);
      return;
    }

    if (ev.data === 'close') {
      this.params.socket.close();
      return;
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

    if (this.params.socket.OPEN) {
      this.params.socket.close(1002, reason);
    }
  }
}

function getUserInfo(request: Request): SessionInfo {
  const url = new URL(request.url);
  const channel = url.pathname;

  const info: SessionInfo = {
    channel,
  };

  const { Authn } = getCookies(request.headers);

  if (Authn != null) {

    // FIXME verify JWT signature
    const jwt = jose.decodeJwt(Authn);

    // FIXME verify user has proper role and can access the requested channel

    info.refId = jwt.userRefId as string;
    info.roles = jwt['http://www.imsglobal.org/imspurl/lis/v1/vocab/person'] as Roles[];
  }

  console.log(info);
  return info;
}


async function reqHandler(request: Request) {


  if (request.headers.get("upgrade") != "websocket") {

    const url = new URL(request.url);
    if (url.pathname === 'favicon.ico') {
      return new Response('');
    }

    const template = await Deno.readTextFile('./ws.html');
    return new Response(template, { headers: { 'Content-Type': 'text/html' }});
  }

  const { channel, refId, roles } = getUserInfo(request);
  const { socket, response } = Deno.upgradeWebSocket(request);
  new Connection({
    channel,
    refId,
    request,
    roles,
    socket,
  });

  return response;
}

const port = parseInt(Deno.args[0] ?? '8000', 10);

serve(reqHandler, { port });
