/**
 * ToptanPortal API - Sanal POS Uc Noktalari
 *
 * Iki uc, iki farkli dunyaya bakar:
 *
 *   * `POST /pos/card-payments` - portal kullanicisi cagirir. Jeton ister.
 *   * `POST /pos/callback/:tenantCode` - BANKA cagirir. Jeton ISTEMEZ ve
 *     istemeyecektir: banka bizim oturumumuzu tasiyamaz. Yerine magaza
 *     anahtariyla hesaplanan ozet dogrulanir (bkz. PosService.handleCallback).
 *
 * Geri donus uctan 302 ile portale yonlendirilir. JSON donmek yanlis olurdu:
 * bu istegin sonunda ekranin basinda bir insan vardir ve tarayicisinda ham
 * JSON gormemelidir.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  startCardPaymentSchema,
  type CardPaymentForm,
  type PosTransactionView,
  type StartCardPaymentRequest,
} from '@toptanportal/contracts';

import {
  BlindOrderExempt,
  CurrentUser,
  Public,
  RateLimit,
  RequirePermissions,
} from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { PosService } from './pos.service';

@ApiTags('Sanal POS')
@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('availability')
  @ApiOperation({ summary: 'Kart ile ödeme açık mı' })
  availability(): { enabled: boolean } {
    return { enabled: this.pos.isEnabled };
  }

  /**
   * Kart ile odeme baslatir ve bankaya gonderilecek formu doner.
   *
   * Hiz siniri dar tutulur: her cagri bir islem kaydi acar ve bankaya bir
   * siparis kimligi ayirir. Sinirsiz cagri, mutabakatta bos islem yigini
   * birakir.
   */
  @Post('card-payments')
  @RequirePermissions(Permission.PAYMENT_CREATE)
  @RateLimit({ limit: 10, windowSeconds: 600, scope: 'USER' })
  @ApiOperation({ summary: '3D Secure ödeme başlat' })
  start(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(startCardPaymentSchema)) body: StartCardPaymentRequest,
  ): Promise<CardPaymentForm> {
    return this.pos.start(principal, body);
  }

  @Get('card-payments/:transactionId')
  @RequirePermissions(Permission.PAYMENT_CREATE)
  @ApiOperation({ summary: 'Ödeme işleminin sonucu' })
  get(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('transactionId', new ParseUUIDPipe({ version: '4' })) transactionId: string,
  ): Promise<PosTransactionView> {
    return this.pos.get(principal, transactionId);
  }

  /**
   * Bankanin geri donus ucu.
   *
   * `@Public()` bilincli ve zorunludur: banka jeton tasiyamaz. Kimlik
   * dogrulamasinin yerini ozet denetimi alir ve o denetim servis katmaninda,
   * hicbir kayda dokunulmadan once yapilir.
   *
   * `@BlindOrderExempt()` de gereklidir: burada oturum yoktur, dolayisiyla
   * suzgecin bakacagi bir rol de yoktur.
   */
  @Post('callback/:tenantCode')
  @Public()
  @BlindOrderExempt()
  @Redirect()
  @ApiExcludeEndpoint()
  async callback(
    @Param('tenantCode') tenantCode: string,
    @Body() payload: Record<string, string>,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.pos.handleCallback(tenantCode, payload ?? {});

    /* 303: tarayici POST'u GET'e cevirerek yonlendirmeyi izler. 302 ile bazi
       tarayicilar POST'u tekrarlar ve kullanici geri tusuna bastiginda banka
       yaniti ikinci kez gonderilir. */
    return { url, statusCode: 303 };
  }
}
