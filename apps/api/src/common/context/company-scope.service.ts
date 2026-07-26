/**
 * ToptanPortal - Cari Kapsam Cozumleyici
 *
 * "Bu kullanici SU cari uzerinde islem yapabilir mi" sorusunun tek cevap yeri.
 *
 * Yetki matrisi neyi gorebilecegini soyler (COMPANY_VIEW_ALL / _ASSIGNED / _OWN);
 * hangi cariyi gorebilecegini soylemez. Ikinci soru veriye bakmayi gerektirir:
 * plasiyerin portfoyunde o bayi var mi, isletme kullanicisi baskasinin carisini
 * mi istiyor. Guard bunu bilemez - istek govdesindeki `companyId` guard
 * calisirken henuz ayristirilmamistir.
 *
 * Kural: istemciden gelen `companyId` DAIMA burada dogrulanir. Hicbir servis
 * kendi basina `dto.companyId` ile sorgu yapmaz.
 */

import { Injectable } from '@nestjs/common';
import { ErrorCode, Permission, roleHasPermission } from '@toptanportal/contracts';

import { PrismaService } from '../prisma/prisma.service';
import { ApiException } from '../exceptions/api.exception';
import { requireCompanyContext } from './company-context';
import type { AuthenticatedPrincipal } from './request-context';

@Injectable()
export class CompanyScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Istegin uzerinde calisacagi cariyi belirler ve erisim hakkini dogrular.
   *
   * @param requested Istemcinin acikca istedigi cari. Bos birakilirsa kullanicinin
   *   kendi carisi (plasiyerde masquerading hedefi) kullanilir.
   */
  async resolve(
    principal: AuthenticatedPrincipal,
    requested?: string | null,
  ): Promise<string> {
    if (!requested) {
      return requireCompanyContext(principal);
    }

    const own = principal.masqueradeCompanyId ?? principal.companyId;

    if (requested === own) {
      return requested;
    }

    if (roleHasPermission(principal.role, Permission.COMPANY_VIEW_ALL)) {
      await this.assertExists(principal.tenantId, requested);
      return requested;
    }

    if (roleHasPermission(principal.role, Permission.COMPANY_VIEW_ASSIGNED)) {
      await this.assertAssigned(principal, requested);
      return requested;
    }

    throw ApiException.forbidden(ErrorCode.COMPANY_SCOPE_VIOLATION);
  }

  /** Plasiyerin portfoyundeki aktif cari kimlikleri. */
  async assignedCompanyIds(principal: AuthenticatedPrincipal): Promise<string[]> {
    const assignments = await this.prisma.salesRepAssignment.findMany({
      where: {
        salesRepUserId: principal.userId,
        isActive: true,
        company: { tenantId: principal.tenantId, isActive: true },
      },
      select: { companyId: true },
    });

    return assignments.map((assignment) => assignment.companyId);
  }

  /**
   * Liste uc noktalari icin cari suzgeci.
   * Tum carileri gorebilen rolde `undefined` doner - suzgec uygulanmaz.
   */
  async listFilter(
    principal: AuthenticatedPrincipal,
    requested?: string | null,
  ): Promise<{ companyId: string } | { companyId: { in: string[] } } | undefined> {
    if (requested) {
      return { companyId: await this.resolve(principal, requested) };
    }

    if (roleHasPermission(principal.role, Permission.COMPANY_VIEW_ALL)) {
      return undefined;
    }

    if (roleHasPermission(principal.role, Permission.COMPANY_VIEW_ASSIGNED)) {
      const own = principal.masqueradeCompanyId;
      if (own) return { companyId: own };

      return { companyId: { in: await this.assignedCompanyIds(principal) } };
    }

    return { companyId: requireCompanyContext(principal) };
  }

  private async assertExists(tenantId: string, companyId: string): Promise<void> {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
      select: { id: true },
    });

    if (!company) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'İşletme bulunamadı.');
    }
  }

  private async assertAssigned(
    principal: AuthenticatedPrincipal,
    companyId: string,
  ): Promise<void> {
    const assignment = await this.prisma.salesRepAssignment.findFirst({
      where: {
        salesRepUserId: principal.userId,
        companyId,
        isActive: true,
        company: { tenantId: principal.tenantId, isActive: true },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw ApiException.forbidden(ErrorCode.COMPANY_SCOPE_VIOLATION);
    }
  }
}
