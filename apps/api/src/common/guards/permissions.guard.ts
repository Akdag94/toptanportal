/**
 * ToptanPortal - Yetki Muhafizi (RBAC)
 *
 * Karar DAIMA permission uzerinden verilir, rol uzerinden degil. Reddedilen her
 * deneme yasal delil loguna islenir; yetkisiz erisim girisimleri sonradan
 * incelenebilir olmalidir.
 */

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuditAction,
  ErrorCode,
  roleHasAllPermissions,
  roleHasAnyPermission,
  type Permission,
} from '@toptanportal/contracts';
import type { UserRole as PrismaUserRole } from '@toptanportal/db';

import { AuditService } from '../audit/audit.service';
import { getRequestContext } from '../context/request-context';
import {
  IS_PUBLIC_KEY,
  PERMISSION_MODE_KEY,
  REQUIRED_PERMISSIONS_KEY,
  type PermissionMode,
} from '../decorators';
import { ApiException } from '../exceptions/api.exception';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Yetki belirtilmemis uc noktalar yalnizca kimlik dogrulamasi ister.
    if (!required || required.length === 0) return true;

    const requestContext = getRequestContext();
    const principal = requestContext?.principal;

    if (!principal) {
      throw ApiException.unauthorized(ErrorCode.SESSION_EXPIRED);
    }

    const mode =
      this.reflector.getAllAndOverride<PermissionMode>(PERMISSION_MODE_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? 'ALL';

    const granted =
      mode === 'ANY'
        ? roleHasAnyPermission(principal.role, required)
        : roleHasAllPermissions(principal.role, required);

    if (granted) return true;

    await this.auditService.recordSafely({
      tenantId: principal.tenantId,
      action: AuditAction.AUTH_PERMISSION_DENIED,
      outcome: 'DENIED',
      resourceType: 'endpoint',
      resourceId: `${requestContext.method} ${requestContext.path}`,
      actorRole: principal.role as PrismaUserRole,
      payload: {
        requiredPermissions: required,
        mode,
        grantedPermissions: principal.permissions,
      },
    });

    throw ApiException.forbidden(ErrorCode.INSUFFICIENT_PERMISSION);
  }
}
