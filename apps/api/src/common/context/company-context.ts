/**
 * Etkin cari cozumleme.
 *
 * Plasiyer bayi adina calisiyorsa (masquerading) islem HEDEF cari uzerinde
 * yapilir; fiyat listesi, stok ambari ve sepet o carinindir. Plasiyerin kendi
 * gordugu kosullar degil, bayinin kosullari gecerlidir.
 *
 * Cari baglami olmayan kullanici (ornek: bayi secmemis plasiyer) ticari islem
 * yapamaz - hangi fiyat listesinin gecerli oldugu belirsiz kalir ve yanlis
 * fiyattan siparis olusma riski dogar.
 */

import { ErrorCode } from '@toptanportal/contracts';

import { ApiException } from '../exceptions/api.exception';
import type { AuthenticatedPrincipal } from './request-context';

export function requireCompanyContext(principal: AuthenticatedPrincipal): string {
  const companyId = principal.masqueradeCompanyId ?? principal.companyId;

  if (!companyId) {
    throw ApiException.forbidden(
      ErrorCode.COMPANY_SCOPE_VIOLATION,
      'Bu işlem için bir işletme bağlamı gereklidir. Önce bayi seçin.',
    );
  }

  return companyId;
}
