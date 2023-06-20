import { serve } from "https://deno.land/std@0.192.0/http/mod.ts";

function send(socket: WebSocket, message: string) {
  console.log(`send ${message}`);
  socket.send(message);
}

function open(_socket: WebSocket, _ev: Event): void {
  console.log(`open`);
}

function close(_socket: WebSocket, _ev: CloseEvent): void {
  console.log(`close`);
}

function message(socket: WebSocket, ev: MessageEvent): void {
  console.log(`recv ${ev.data}`);
  if (ev.data === 'ping') {
    send(socket, 'pong');
  }

  if (ev.data === 'close') {
    socket.close();
  }
}

function error(_socket: WebSocket, ev: Event | ErrorEvent): void {
  if (ev instanceof ErrorEvent) {
    console.log(`⚠️ ${ev.message}`);
  } else {
    console.log(`⚠️ ${ev.type}`);
  }
}

async function reqHandler(req: Request) {

  if (req.headers.get("upgrade") != "websocket") {

    const url = new URL(req.url);

    if (url.pathname === 'favicon.ico') {
      return new Response('');
    }

    const template = await Deno.readTextFile('./ws.html');
    return new Response(template, { headers: { 'Content-Type': 'text/html' }});
  }

  console.log(`😀`);

  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = (ev: Event) => open(socket, ev);
  socket.onmessage = (ev: MessageEvent) => message(socket, ev);
  socket.onclose = (ev: CloseEvent) => close(socket, ev);
  socket.onerror = (ev: Event | ErrorEvent) => error(socket, ev);

  return response;
}

serve(reqHandler, { port: 8000 });
