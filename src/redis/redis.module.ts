import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (configService: ConfigService) => {
        let redisUrl = configService.get<string>('redisUrl') || '';
        
        try {
          redisUrl = decodeURIComponent(redisUrl).trim();
        } catch (err) {
          redisUrl = redisUrl.trim();
        }

        // Strip wrapping quotes
        redisUrl = redisUrl.replace(/^['"]|['"]$/g, '').trim();

        // Strip redis-cli flags
        if (redisUrl.startsWith('-u ')) {
          redisUrl = redisUrl.substring(3).trim();
        } else if (redisUrl.startsWith('--uri ')) {
          redisUrl = redisUrl.substring(6).trim();
        }
        
        // Handle case where "-u" is embedded with leading characters
        redisUrl = redisUrl.replace(/^.*?-u\s+/, '').trim();

        return new Redis(redisUrl, {
          maxRetriesPerRequest: null,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
