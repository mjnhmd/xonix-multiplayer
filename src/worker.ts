import { GameRoom, Lobby } from './game-room';

interface Env {
  GAME_ROOMS: DurableObjectNamespace;
  LOBBY: DurableObjectNamespace;
}

export { GameRoom, Lobby };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/find-room') {
      const lobbyId = env.LOBBY.idFromName('global');
      const lobby = env.LOBBY.get(lobbyId);
      return lobby.fetch(new Request(new URL('/find-room', url.origin)));
    }

    if (url.pathname === '/api/room-joined') {
      const lobbyId = env.LOBBY.idFromName('global');
      const lobby = env.LOBBY.get(lobbyId);
      const roomId = url.searchParams.get('roomId') || '';
      return lobby.fetch(new Request(new URL(`/room-joined?roomId=${roomId}`, url.origin)));
    }

    if (url.pathname === '/api/room-left') {
      const lobbyId = env.LOBBY.idFromName('global');
      const lobby = env.LOBBY.get(lobbyId);
      const roomId = url.searchParams.get('roomId') || '';
      return lobby.fetch(new Request(new URL(`/room-left?roomId=${roomId}`, url.origin)));
    }

    if (url.pathname.startsWith('/api/room/')) {
      const parts = url.pathname.split('/');
      const roomId = parts[3];
      const action = parts[4] || 'status';

      if (!roomId) return new Response('Missing room ID', { status: 400 });

      const doId = env.GAME_ROOMS.idFromName(roomId);
      const room = env.GAME_ROOMS.get(doId);

      if (action === 'ws') {
        const upgradeHeader = request.headers.get('Upgrade');
        if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
          return new Response('Expected WebSocket', { status: 426 });
        }
        const name = url.searchParams.get('name') || '';
        return room.fetch(new Request(new URL(`/ws?name=${encodeURIComponent(name)}`, url.origin), {
          headers: request.headers,
        }));
      }

      return room.fetch(new Request(new URL(`/${action}`, url.origin)));
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
