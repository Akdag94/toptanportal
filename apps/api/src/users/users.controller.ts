/**
 * ToptanPortal API - Kullanici Yonetimi Uc Noktalari
 *
 * Iki farkli yonetici bu uclari paylasir: Super Admin (tum kiraci) ve isletme
 * ana yetkilisi (kendi isletmesi). Ayrimi servis katmani yapar - denetleyicide
 * iki ayri uc acmak, ayni is kuralini iki yerde tutmak olurdu.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  inviteUserSchema,
  setSpendingLimitSchema,
  updateUserStatusSchema,
  userListQuerySchema,
  type InviteUserRequest,
  type InviteUserResult,
  type ManagedUser,
  type SetSpendingLimitRequest,
  type UpdateUserStatusRequest,
  type UserListQuery,
  type UserPage,
} from '@toptanportal/contracts';

import { CurrentUser, RateLimit, RequireAnyPermission, RequirePermissions } from '../common/decorators';
import { zodBody } from '../common/pipes/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../common/context/request-context';
import { UsersService } from './users.service';

@ApiTags('Kullanıcılar')
@Controller('users')
@RequireAnyPermission(Permission.USER_MANAGE_COMPANY, Permission.USER_MANAGE_ALL)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Kullanıcı listesi' })
  list(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Query(zodBody(userListQuerySchema)) query: UserListQuery,
  ): Promise<UserPage> {
    return this.users.list(principal, query);
  }

  /**
   * Kullanici davet eder ve tek kullanimlik sifreyi doner.
   *
   * Hiz siniri dardir: davet, e-posta adresi dogrulanmadan hesap acar ve
   * sinirsiz cagri, kiraciyi olu hesaplarla doldurur.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: 20, windowSeconds: 3600, scope: 'USER' })
  @ApiOperation({ summary: 'Kullanıcı davet et' })
  invite(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Body(zodBody(inviteUserSchema)) body: InviteUserRequest,
  ): Promise<InviteUserResult> {
    return this.users.invite(principal, body);
  }

  @Post(':userId/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Kullanıcıyı etkinleştir / askıya al' })
  setStatus(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body(zodBody(updateUserStatusSchema)) body: UpdateUserStatusRequest,
  ): Promise<ManagedUser> {
    return this.users.setStatus(principal, userId, body.status);
  }

  /**
   * Alt kullanicinin harcama limiti.
   *
   * Ayri bir yetki ister (`USER_LIMIT_MANAGE`): limit, siparisin onaya dusup
   * dusmeyecegini belirler ve bu, kullanici yonetmekten farkli bir ticari
   * karardir.
   */
  @Post(':userId/spending-limit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.USER_LIMIT_MANAGE)
  @ApiOperation({ summary: 'Harcama limiti tanımla' })
  setSpendingLimit(
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body(zodBody(setSpendingLimitSchema)) body: SetSpendingLimitRequest,
  ): Promise<ManagedUser> {
    return this.users.setSpendingLimit(principal, userId, body);
  }
}
