import { Router, Request, Response } from 'express';
import { TransactionStreamer } from '../services/transactionStreamer';
import { logger } from '../utils/logger';

export function createRealtimeRouter(streamer: TransactionStreamer): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const type = (req.query.type as string) || 'both';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    res.write('event: connected\ndata: {"status":"connected"}\n\n');

    const sendEvent = (eventName: string, data: unknown) => {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onTransactions = (txs: unknown[]) => {
      if (type === 'transactions' || type === 'both') {
        sendEvent('transactions', txs);
      }
    };

    const onTrades = (trades: unknown[]) => {
      if (type === 'trades' || type === 'both') {
        sendEvent('trades', trades);
      }
    };

    const onOrders = (orders: unknown[]) => {
      if (type === 'orders' || type === 'both') {
        sendEvent('orders', orders);
      }
    };

    streamer.on('transactions', onTransactions);
    streamer.on('trades', onTrades);
    streamer.on('orders', onOrders);

    const heartbeat = setInterval(() => {
      res.write(':heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      streamer.off('transactions', onTransactions);
      streamer.off('trades', onTrades);
      streamer.off('orders', onOrders);
      clearInterval(heartbeat);
      logger.debug('SSE client disconnected');
    });
  });

  router.get('/snapshot', (_req: Request, res: Response) => {
    const snapshot = streamer.getSnapshot();
    res.json({
      success: true,
      data: snapshot,
    });
  });

  return router;
}
