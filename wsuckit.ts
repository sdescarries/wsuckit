import { serve } from "https://deno.land/std@0.192.0/http/mod.ts";
import { connect, RedisSubscription } from "https://deno.land/x/redis@v0.30.0/mod.ts";

const redis = await connect({ hostname: "localhost" });
const multi = new Map<string, MultiCaster>();

class MultiCaster {
  channel: string;
  connections = new Set<Connection>();
  sub?: RedisSubscription;

  constructor(channel: string) {
    this.channel = channel;
    this.listen();
  }

  static register(con: Connection) {
    let caster = multi.get(con.channel);
    if (caster == null) {
      caster = new MultiCaster(con.channel);
      multi.set(con.channel, caster);
    }
    caster.add(con);
  }

  async listenLoop(sub: RedisSubscription) {
    this.sub = sub;
    console.log(`[${this.channel}] start listenLoop`);

    for await (const { channel, message } of sub.receive()) {
      console.log({ channel, message });
      this.connections.forEach(con => con.send(message));
    }

    console.log(`[${this.channel}] stop listenLoop`);
  }

  listen = () =>
    redis
      .subscribe(this.channel)
      .then(sub => this.listenLoop(sub));

  add(con: Connection) {
    console.log(`[${this.channel}] add listener`);
    this.connections.add(con);
  }

  rem(con: Connection) {
    console.log(`[${this.channel}] rem listener`);
    this.connections.delete(con);

    if (this.connections.size === 0) {
      this.sub?.close();
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

  channel: string;
  request: Request;
  socket: WebSocket;
  sub?: RedisSubscription;

  constructor(params: ConnectionParams) {
    this.channel = params.channel;
    this.request = params.request;
    this.socket = params.socket;

    this.socket.onopen = (ev: Event) => this.open(ev);
    this.socket.onmessage = (ev: MessageEvent) => this.message(ev);
    this.socket.onclose = (ev: CloseEvent) => this.close(ev);
    this.socket.onerror = (ev: Event | ErrorEvent) => this.error(ev);

    this.listen();
  }

  async listenLoop(sub: RedisSubscription) {
    this.sub = sub;
    while(!sub.isClosed) {
      for await (const { channel, message } of sub.receive()) {
        console.log({ channel, message });
        this.send(message);
      }
    }
  }

  listen() {
    redis
      .subscribe(this.channel)
      .then(sub => this.listenLoop(sub))
      .catch(error => this.error(error));
  }

  send(message: string) {
    console.log(`send ${message}`);
    this.socket.send(message);
  }

  open(_ev: Event): void {
    console.log(`open ${this.channel} ${this.request.headers.get('host')}`);
  }

  close(_ev: CloseEvent): void {
    console.log(`close`);
  }

  message(ev: MessageEvent): void {
    console.log(`recv ${ev.data}`);
    if (ev.data === 'ping') {
      this.send('pong');
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

    this.sub?.close();

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

  console.log(`😀 ${channel}`);

  const { socket, response } = Deno.upgradeWebSocket(request);

  const connection = new Connection({ socket, channel, request });
  MultiCaster.register(connection);

  return response;
}

serve(reqHandler, { port: 8000 });
