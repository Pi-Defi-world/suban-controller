import { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import {
  controlRateLimit,
  requireControlAuth,
  resetControlRateLimitForTests,
} from './auth';

function mockResponse(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res as Response;
}

function mockRequest(overrides: Partial<Request> = {}): Request {
  return {
    header: jest.fn().mockReturnValue(undefined),
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    path: '/api/v1/price/commit',
    method: 'POST',
    ...overrides,
  } as unknown as Request;
}

describe('controller control-plane auth', () => {
  const originalKey = config.controlApiKey;
  const originalLimit = config.controlRateLimitPerMinute;

  afterEach(() => {
    config.controlApiKey = originalKey;
    config.controlRateLimitPerMinute = originalLimit;
    resetControlRateLimitForTests();
    jest.clearAllMocks();
  });

  it('returns 503 when no admin key is configured', () => {
    config.controlApiKey = '';
    const res = mockResponse();
    const next = jest.fn() as NextFunction;

    requireControlAuth(mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is missing', () => {
    config.controlApiKey = 'secret-key';
    const res = mockResponse();
    const next = jest.fn() as NextFunction;

    requireControlAuth(mockRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when the key is wrong', () => {
    config.controlApiKey = 'secret-key';
    const req = mockRequest({
      header: jest.fn().mockReturnValue('wrong-key'),
    });
    const res = mockResponse();
    const next = jest.fn() as NextFunction;

    requireControlAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts x-api-key', () => {
    config.controlApiKey = 'secret-key';
    const req = mockRequest({
      header: jest.fn((name: string) =>
        name.toLowerCase() === 'x-api-key' ? 'secret-key' : undefined
      ) as any,
    });
    const res = mockResponse();
    const next = jest.fn() as NextFunction;

    requireControlAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts a Bearer token', () => {
    config.controlApiKey = 'secret-key';
    const req = mockRequest({
      header: jest.fn((name: string) =>
        name.toLowerCase() === 'authorization'
          ? 'Bearer secret-key'
          : undefined
      ) as any,
    });
    const res = mockResponse();
    const next = jest.fn() as NextFunction;

    requireControlAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rate limits control requests', () => {
    config.controlRateLimitPerMinute = 2;
    resetControlRateLimitForTests();
    const req = mockRequest();

    for (let i = 0; i < 2; i++) {
      const res = mockResponse();
      const next = jest.fn() as NextFunction;
      controlRateLimit(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }

    const res = mockResponse();
    const next = jest.fn() as NextFunction;
    controlRateLimit(req, res, next);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(next).not.toHaveBeenCalled();
  });
});
