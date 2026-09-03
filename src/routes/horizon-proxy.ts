/**
 * Horizon API proxy - proxies requests to our local Horizon nodes
 */
import { Router, Request, Response } from 'express';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const router = Router();

function getHorizonUrl(): string {
  return config.network === 'testnet' ? config.horizon.testnet : config.horizon.mainnet;
}

export function createHorizonProxyRouter(): Router {
  /**
   * Proxy all Horizon API requests to our local Horizon node
   */
  router.all('/*', async (req: Request, res: Response) => {
    try {
      const path = req.path;
      const method = req.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
      const baseURL = getHorizonUrl();
      
      logger.debug(`Proxying Horizon request: ${method.toUpperCase()} ${path} -> ${baseURL}`);
      
      const response = await axios({
        method,
        url: `${baseURL}${path}`,
        params: req.query,
        data: req.body,
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });

      res.json(response.data);
    } catch (error: any) {
      const status = error.response?.status || 500;
      const message = error.response?.data || error.message;
      
      logger.error('Horizon proxy error', {
        path: req.path,
        status,
        message,
      });
      
      res.status(status).json({
        error: 'Horizon API error',
        message,
      });
    }
  });

  return router;
}

