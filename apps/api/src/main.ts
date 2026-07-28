import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = config.get<number>('port') ?? 4000;
  const apiPrefix = config.get<string>('apiPrefix') ?? 'api/v1';
  const isProduction = config.get<string>('env') === 'production';

  app.setGlobalPrefix(apiPrefix);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());

  // Correlation id ties an API log line, an audit row and a browser error report
  // together. Honour an inbound one so a trace survives the hop from the web app.
  app.use((req: Request & { correlationId?: string }, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' ? incoming : randomUUID();
    res.setHeader('x-correlation-id', req.correlationId);
    next();
  });

  app.enableCors({
    origin: isProduction
      ? [config.get<string>('appUrl') ?? 'http://localhost:3000']
      : true,
    credentials: true,
    exposedHeaders: ['x-correlation-id', 'content-disposition'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties rather than trusting them: without this, a client
      // could post `{ grandTotal: 1 }` and overwrite a computed field.
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger is the API documentation deliverable; it stays off in production because
  // publishing a complete map of the endpoints helps an attacker more than a developer.
  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Intoto ERP API')
        .setDescription(
          'AI-powered ERP for Indian clothing wholesale & retail.\n\n' +
            'All money values are returned as decimal strings to preserve precision — ' +
            'parse them as decimals, never as floats.\n\n' +
            'Send `x-shop-id` to scope a request to a branch.',
        )
        .setVersion('1.0.0')
        .addBearerAuth()
        .addGlobalParameters({
          name: 'x-shop-id',
          in: 'header',
          required: false,
          schema: { type: 'string' },
          description: 'Active shop for this request',
        })
        .build(),
    );
    SwaggerModule.setup(`${apiPrefix}/docs`, app, document, {
      swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    });
  }

  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  logger.log(`Intoto ERP API listening on http://localhost:${port}/${apiPrefix}`);
  if (!isProduction) {
    logger.log(`API documentation: http://localhost:${port}/${apiPrefix}/docs`);
  }
}

void bootstrap();
