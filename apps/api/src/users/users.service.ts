/**
 * ToptanPortal API - Kullanici Yonetimi
 *
 * KAPSAM KURALI: isletme ana yetkilisi YALNIZCA kendi isletmesinin
 * kullanicilarini yonetir (`USER_MANAGE_COMPANY`); Super Admin tumunu
 * (`USER_MANAGE_ALL`). Kapsam sorguya girer, sonradan suzulmez.
 *
 * YETKI YUKSELTME ENGELI: bir kullanici, kendi rolunden daha genis yetkili bir
 * rol olusturamaz. Aksi halde isletme yetkilisi kendine bir plasiyer hesabi
 * acar ve TUM bayilerin portfoyunu gorur - bu, rol sisteminin tamamini
 * anlamsiz kilar.
 */

import { Injectable } from '@nestjs/common';
import { Prisma, UserStatus } from '@toptanportal/db';
import { randomBytes } from 'node:crypto';
import {
  ErrorCode,
  NotificationTopic,
  Permission,
  ROLE_LABELS,
  SUPPLIER_SIDE_ROLES,
  UserRole,
  roleHasPermission,
  type InviteUserRequest,
  type InviteUserResult,
  type ManagedUser,
  type SetSpendingLimitRequest,
  type UserListQuery,
  type UserPage,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { CryptoService } from '../common/crypto/crypto.service';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

const USER_INCLUDE = {
  company: { select: { title: true } },
  spendingLimit: true,
} as const;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly notifications: NotificationService,
  ) {}

  async list(principal: AuthenticatedPrincipal, query: UserListQuery): Promise<UserPage> {
    const where: Prisma.UserWhereInput = {
      tenantId: principal.tenantId,
      ...this.kapsam(principal, query.companyId),
      ...(query.role ? { role: query.role } : {}),
      ...(query.q
        ? {
            OR: [
              { fullName: { contains: query.q, mode: 'insensitive' } },
              { email: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [kullanicilar, toplam] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: kullanicilar.map((kullanici) => this.toView(kullanici)),
      totalCount: toplam,
      hasMore: query.offset + kullanicilar.length < toplam,
    };
  }

  async invite(
    principal: AuthenticatedPrincipal,
    request: InviteUserRequest,
  ): Promise<InviteUserResult> {
    this.rolAtamasiniDenetle(principal, request.role);

    const companyId = this.hedefIsletme(principal, request);
    const emailNormalized = request.email.trim().toLowerCase();

    const mevcut = await this.prisma.user.findFirst({
      where: { tenantId: principal.tenantId, emailNormalized },
      select: { id: true },
    });

    if (mevcut) {
      throw ApiException.conflict(
        ErrorCode.CONFLICT,
        'Bu e-posta adresiyle bir kullanıcı zaten tanımlı.',
      );
    }

    /* Tek kullanimlik sifre SUNUCUDA uretilir ve yalnizca bu yanitta doner.
       Yoneticinin belirledigi bir sifre, kullanicinin sifresini bilen ikinci
       bir kisi demektir; o hesapla yapilan islemin kime ait oldugu tartismali
       hale gelir ve denetim kaydinin degeri de buna baglidir. */
    const gecici = this.geciciSifreUret();

    const kullanici = await this.prisma.user.create({
      data: {
        tenantId: principal.tenantId,
        companyId,
        email: request.email.trim(),
        emailNormalized,
        fullName: request.fullName,
        role: request.role,
        status: UserStatus.INVITED,
        passwordHash: await this.crypto.hashPassword(gecici),
        mustChangePassword: true,
      },
      include: USER_INCLUDE,
    });

    return { user: this.toView(kullanici), temporaryPassword: gecici };
  }

  async setStatus(
    principal: AuthenticatedPrincipal,
    userId: string,
    status: 'ACTIVE' | 'SUSPENDED',
  ): Promise<ManagedUser> {
    const hedef = await this.kapsamdaBul(principal, userId);

    /* Kullanici KENDI hesabini askiya alamaz: yanlislikla yapildiginda geri
       almak icin baska bir yonetici gerekir ve tek yoneticili bir kurulumda
       sistem kilitlenir. */
    if (hedef.id === principal.userId) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Kendi hesabınızın durumunu değiştiremezsiniz.',
      );
    }

    const guncel = await this.prisma.user.update({
      where: { id: hedef.id },
      data: {
        status: status === 'ACTIVE' ? UserStatus.ACTIVE : UserStatus.SUSPENDED,
        ...(status === 'ACTIVE' ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
      include: USER_INCLUDE,
    });

    if (status === 'SUSPENDED') {
      /* Acik oturumlar da kapatilir. Yalnizca durumu degistirmek, erisimi
         jetonun suresi dolana kadar (15 dk) surdururdu - askiya alma karari
         verildigi anda etkili olmalidir. */
      await this.prisma.session.updateMany({
        where: { userId: hedef.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    /* Askiya alinan kullaniciya da bildirim gider - hatta ASIL o gitmelidir:
       erisimi kesilen kisi, bunun bir ariza mi karar mi oldugunu bilmelidir.
       Bildirim konusu guvenliktir ve guvenlik bildirimi hesap durumundan
       bagimsiz gonderilir (bkz. NotificationService.aliciUygunMu). */
    await this.notifications.enqueue({
      tenantId: principal.tenantId,
      payload: {
        topic: NotificationTopic.SECURITY,
        eventLabel: status === 'ACTIVE' ? 'Hesabınız yeniden etkinleştirildi' : 'Hesabınız askıya alındı',
        occurredAt: new Date().toISOString(),
      },
      recipientUserIds: [hedef.id],
      dedupeKey: `security:${hedef.id}:status:${status}:${Date.now()}`,
      relatedType: 'User',
      relatedId: hedef.id,
    });

    return this.toView(guncel);
  }

  async setSpendingLimit(
    principal: AuthenticatedPrincipal,
    userId: string,
    request: SetSpendingLimitRequest,
  ): Promise<ManagedUser> {
    const hedef = await this.kapsamdaBul(principal, userId);

    await this.prisma.userSpendingLimit.upsert({
      where: { userId: hedef.id },
      create: {
        userId: hedef.id,
        perOrderLimit: request.perOrderLimit,
        monthlyLimit: request.monthlyLimit,
        alwaysRequiresApproval: request.alwaysRequiresApproval,
        updatedByUserId: principal.userId,
      },
      update: {
        perOrderLimit: request.perOrderLimit,
        monthlyLimit: request.monthlyLimit,
        alwaysRequiresApproval: request.alwaysRequiresApproval,
        updatedByUserId: principal.userId,
      },
    });

    const guncel = await this.prisma.user.findUniqueOrThrow({
      where: { id: hedef.id },
      include: USER_INCLUDE,
    });

    return this.toView(guncel);
  }

  // -------------------------------------------------------------------------
  // Kapsam ve yetki
  // -------------------------------------------------------------------------

  private kapsam(principal: AuthenticatedPrincipal, requested?: string): Prisma.UserWhereInput {
    if (roleHasPermission(principal.role, Permission.USER_MANAGE_ALL)) {
      return requested ? { companyId: requested } : {};
    }

    /* Isletme yetkilisi kendi isletmesiyle sinirlidir; `companyId` parametresi
       kapsami GENISLETEMEZ, yok sayilir. Isletmesi olmayan bir hesap hicbir
       kullanici gormez - eslesmeyen bir kimlik bilincli olarak konur. */
    return { companyId: principal.companyId ?? '00000000-0000-4000-8000-000000000000' };
  }

  private async kapsamdaBul(
    principal: AuthenticatedPrincipal,
    userId: string,
  ): Promise<UserRow> {
    const kullanici = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: principal.tenantId, ...this.kapsam(principal) },
      include: USER_INCLUDE,
    });

    if (!kullanici) {
      throw ApiException.notFound(ErrorCode.RESOURCE_NOT_FOUND, 'Kullanıcı bulunamadı.');
    }

    return kullanici;
  }

  /**
   * Rol atamasini denetler.
   *
   * Isletme yetkilisi yalnizca ISLETME rollerini acabilir. Toptanci tarafi
   * rolleri (Super Admin, Plasiyer) yalnizca USER_MANAGE_ALL yetkisiyle
   * verilir.
   */
  private rolAtamasiniDenetle(principal: AuthenticatedPrincipal, role: UserRole): void {
    if (roleHasPermission(principal.role, Permission.USER_MANAGE_ALL)) return;

    if (SUPPLIER_SIDE_ROLES.includes(role)) {
      throw ApiException.forbidden(
        ErrorCode.INSUFFICIENT_PERMISSION,
        'Bu rolü tanımlama yetkiniz yok.',
      );
    }
  }

  private hedefIsletme(
    principal: AuthenticatedPrincipal,
    request: InviteUserRequest,
  ): string | null {
    if (SUPPLIER_SIDE_ROLES.includes(request.role)) return null;

    const companyId = roleHasPermission(principal.role, Permission.USER_MANAGE_ALL)
      ? request.companyId
      : principal.companyId;

    if (!companyId) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'İşletme rolleri için bayi seçimi zorunludur.',
      );
    }

    return companyId;
  }

  /**
   * Okunabilir ama tahmin edilemez gecici sifre.
   *
   * Karistirilabilen karakterler (0/O, 1/l/I) DISARIDA birakilir: sifre
   * telefonda okunacaktir ve yanlis anlasilan bir karakter, kullaniciyi
   * hesabin kilitlendigi bir deneme dizisine goturur.
   */
  private geciciSifreUret(): string {
    const alfabe = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bayt = randomBytes(14);

    let sifre = '';
    for (const deger of bayt) {
      sifre += alfabe[deger % alfabe.length];
    }

    /* Sonek, karmasiklik kuralini garantiye alir: uretilen dizide rakam
       cikmama ihtimali dusuktur ama sifir degildir. */
    return `${sifre}-7Aa`;
  }

  private toView(kullanici: UserRow): ManagedUser {
    return {
      id: kullanici.id,
      email: kullanici.email,
      fullName: kullanici.fullName,
      role: kullanici.role,
      roleLabel: ROLE_LABELS[kullanici.role],
      status: kullanici.status,
      companyId: kullanici.companyId,
      companyTitle: kullanici.company?.title ?? null,
      mfaEnrolled: kullanici.mfaEnrolledAt !== null,
      mfaRequired: kullanici.mfaRequired,
      lastLoginAt: kullanici.lastLoginAt?.toISOString() ?? null,
      createdAt: kullanici.createdAt.toISOString(),
      perOrderLimit: kullanici.spendingLimit?.perOrderLimit?.toNumber() ?? null,
      monthlyLimit: kullanici.spendingLimit?.monthlyLimit?.toNumber() ?? null,
      alwaysRequiresApproval: kullanici.spendingLimit?.alwaysRequiresApproval ?? false,
    };
  }
}
