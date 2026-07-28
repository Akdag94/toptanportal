/**
 * ToptanPortal API - Ziyaret Notlari
 *
 * Not EKLENIR, degistirilmez. Veritabani tetikleyicisi metni ve sahibini
 * kilitler; burada da guncelleme ucu YOKTUR - iki katman ayni seyi soyler.
 *
 * Takip tarihi (`followUpDate`) plasiyerin gunluk is listesini uretir: bugun ve
 * oncesine dusen takipler "gecikmis" sayilir ve sayilari her yanitta doner.
 * Sayiyi ayri bir uca koymak, ekranin onu cagirmayi unutmasini mumkun kilardi.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@toptanportal/db';
import {
  ErrorCode,
  VISIT_OUTCOME_LABELS,
  type CreateVisitNoteRequest,
  type VisitNote,
  type VisitNotePage,
  type VisitNoteQuery,
} from '@toptanportal/contracts';

import { ApiException } from '../common/exceptions/api.exception';
import { CompanyScopeService } from '../common/context/company-scope.service';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthenticatedPrincipal } from '../common/context/request-context';

const VISIT_INCLUDE = {
  company: { select: { title: true } },
  author: { select: { fullName: true } },
} as const;

type VisitRow = Prisma.VisitNoteGetPayload<{ include: typeof VISIT_INCLUDE }>;

@Injectable()
export class VisitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: CompanyScopeService,
  ) {}

  async create(
    principal: AuthenticatedPrincipal,
    request: CreateVisitNoteRequest,
  ): Promise<VisitNote> {
    /* Kapsam denetimi: plasiyer yalnizca kendi portfoyune not yazabilir.
       Atanmamis bir bayiye not yazmak, o bayinin gecmisine yabanci bir kayit
       sokmaktir. */
    const companyId = await this.scope.resolve(principal, request.companyId);

    const visitedAt = request.visitedAt ? new Date(request.visitedAt) : new Date();

    /* Gelecek tarihli ziyaret kaydedilemez: ziyaret olmus bir seydir, plan
       degil. Plan `followUpDate` alanindadir. */
    if (visitedAt.getTime() > Date.now() + 60_000) {
      throw ApiException.unprocessable(
        ErrorCode.VALIDATION_FAILED,
        'Ziyaret tarihi gelecekte olamaz. Planlama için takip tarihini kullanın.',
      );
    }

    const not = await this.prisma.visitNote.create({
      data: {
        tenantId: principal.tenantId,
        companyId,
        authorUserId: principal.userId,
        outcome: request.outcome,
        note: request.note,
        latitude: request.latitude ?? null,
        longitude: request.longitude ?? null,
        followUpDate: request.followUpDate ? new Date(request.followUpDate) : null,
        visitedAt,
      },
      include: VISIT_INCLUDE,
    });

    return this.toView(not);
  }

  async list(
    principal: AuthenticatedPrincipal,
    query: VisitNoteQuery,
  ): Promise<VisitNotePage> {
    const kapsam = await this.scope.listFilter(principal, query.companyId);
    const bugun = new Date();
    bugun.setUTCHours(23, 59, 59, 999);

    const where: Prisma.VisitNoteWhereInput = {
      tenantId: principal.tenantId,
      ...(kapsam ?? {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.dueOnly ? { followUpDate: { not: null, lte: bugun } } : {}),
    };

    const [notlar, toplam, gecikmis] = await Promise.all([
      this.prisma.visitNote.findMany({
        where,
        include: VISIT_INCLUDE,
        orderBy: { visitedAt: 'desc' },
        skip: query.offset,
        take: query.limit,
      }),
      this.prisma.visitNote.count({ where }),
      this.prisma.visitNote.count({
        where: {
          tenantId: principal.tenantId,
          ...(kapsam ?? {}),
          followUpDate: { not: null, lte: bugun },
        },
      }),
    ]);

    return {
      notes: notlar.map((not) => this.toView(not)),
      totalCount: toplam,
      hasMore: query.offset + notlar.length < toplam,
      overdueFollowUps: gecikmis,
    };
  }

  private toView(not: VisitRow): VisitNote {
    return {
      id: not.id,
      companyId: not.companyId,
      companyTitle: not.company.title,
      outcome: not.outcome,
      outcomeLabel: VISIT_OUTCOME_LABELS[not.outcome],
      note: not.note,
      latitude: not.latitude?.toNumber() ?? null,
      longitude: not.longitude?.toNumber() ?? null,
      followUpDate: not.followUpDate?.toISOString() ?? null,
      visitedAt: not.visitedAt.toISOString(),
      authorName: not.author.fullName,
      createdAt: not.createdAt.toISOString(),
    };
  }
}
