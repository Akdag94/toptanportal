import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import type { AppConfig } from '../config/configuration';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { TotpService } from './totp.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const config = configService.getOrThrow<AppConfig>('app');
        return {
          secret: config.JWT_ACCESS_SECRET,
          signOptions: {
            algorithm: 'HS256',
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE,
          },
          verifyOptions: {
            algorithms: ['HS256'],
            issuer: config.JWT_ISSUER,
            audience: config.JWT_AUDIENCE,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, TokenService, TotpService],
  exports: [AuthService, TokenService, JwtModule],
})
export class AuthModule {}
