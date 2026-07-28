import Foundation

// MARK: - Katalog, sepet, siparis ve saha modelleri
//
// @toptanportal/contracts paketindeki semalarin birebir karsiligidir.
//
// KOR SIPARIS KURALI: parasal alanlarin tamami OPSIYONELDIR. Sunucu yetkisi
// olmayan kullaniciya bu alanlari HIC gondermez - bos veya sifir degil, alanin
// kendisi yoktur. Arayuz `if let` ile kontrol etmeli, `?? 0` YAZMAMALIDIR:
// sifir fiyat, gizlenmis fiyattan gorsel olarak ayirt edilemez ve musteri onu
// gercek bir bedel sanabilir.

// MARK: Katalog

enum StockStatus: String, Codable, Sendable {
    case inStock = "IN_STOCK"
    case low = "LOW"
    case outOfStock = "OUT_OF_STOCK"

    var etiket: String {
        switch self {
        case .inStock: "Stokta"
        case .low: "Son birkaç"
        case .outOfStock: "Tükendi"
        }
    }
}

struct ProductUnitView: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let code: String
    let name: String
    let conversionFactor: Double
    let isDefaultForOrder: Bool
    /// Yetkisiz kullanicida GELMEZ.
    let unitPrice: Double?
}

struct CatalogProduct: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let code: String
    let name: String
    let brand: String?
    let imageUrl: String?
    let baseUnitCode: String
    let units: [ProductUnitView]
    let stockStatus: StockStatus
    /// Kesin stok adedi yalnizca yetkili kullanicida gelir.
    let availableQuantity: Double?
    let vatRate: Double?

    var varsayilanBirim: ProductUnitView? {
        units.first(where: { $0.isDefaultForOrder }) ?? units.first
    }
}

struct CatalogPage: Codable, Sendable {
    let items: [CatalogProduct]
    let nextCursor: String?
}

struct BarcodeMatch: Codable, Sendable {
    let product: CatalogProduct
    /// Barkod hangi birime aitse o birim onceden secilir - koli barkodu
    /// okutuldugunda adet secili gelmesi, depoda yanlis miktar girisi uretir.
    let matchedUnitCode: String?
}

// MARK: Sepet

struct CartItemInput: Codable, Sendable {
    let productId: String
    let unitId: String
    let quantity: Double
}

struct CartLine: Codable, Hashable, Sendable, Identifiable {
    let productId: String
    let unitId: String
    let productName: String
    let productCode: String
    let unitCode: String
    let quantity: Double
    let stockStatus: StockStatus
    let unitPrice: Double?
    let lineTotal: Double?

    var id: String { "\(productId)-\(unitId)" }
}

struct CartView: Codable, Sendable {
    let lines: [CartLine]
    let currency: String
    let blindOrderMode: Bool
    let hasStockIssue: Bool
    let grossTotal: Double?
    let discountTotal: Double?
    let netTotal: Double?
    let vatTotal: Double?
    let grandTotal: Double?
}

// MARK: Siparis

enum OrderStatus: String, Codable, Sendable {
    case pendingApproval = "PENDING_APPROVAL"
    case queued = "QUEUED"
    case sending = "SENDING"
    case confirmed = "CONFIRMED"
    case rejected = "REJECTED"
    case cancelled = "CANCELLED"
    case failed = "FAILED"

    var etiket: String {
        switch self {
        case .pendingApproval: "Onay Bekliyor"
        case .queued: "Sıraya Alındı"
        case .sending: "İletiliyor"
        case .confirmed: "Onaylandı"
        case .rejected: "Reddedildi"
        case .cancelled: "İptal Edildi"
        case .failed: "Başarısız"
        }
    }
}

struct OrderView: Codable, Sendable, Identifiable {
    let id: String
    let orderNumber: String
    let status: OrderStatus
    let submittedAt: String
    let currency: String
    let grandTotal: Double?
    let logoOrderNumber: String?
}

struct PlaceOrderResult: Codable, Sendable {
    let order: OrderView
    let requiresApproval: Bool
    let message: String
}

// MARK: Rutin siparis sablonlari

struct OrderTemplateView: Codable, Sendable, Identifiable {
    let id: String
    let name: String
    let itemCount: Int
    let isShared: Bool
    let lastUsedAt: String?
}

struct ApplyTemplateResult: Codable, Sendable {
    let cart: CartView
    /// Sablondaki bazi urunler artik satista olmayabilir; kullanici bunu
    /// SEPETE BAKMADAN once ogrenmelidir.
    let skippedProducts: [String]
}

// MARK: Saha tahsilati

enum PaymentMethod: String, Codable, Sendable, CaseIterable {
    case cash = "CASH"
    case bankTransfer = "BANK_TRANSFER"
    case creditCard = "CREDIT_CARD"
    case cheque = "CHEQUE"
    case promissoryNote = "PROMISSORY_NOTE"
    case dbs = "DBS"

    var etiket: String {
        switch self {
        case .cash: "Nakit"
        case .bankTransfer: "Havale / EFT"
        case .creditCard: "Kredi Kartı"
        case .cheque: "Çek"
        case .promissoryNote: "Senet"
        case .dbs: "DBS"
        }
    }

    /// Sahada plasiyerin elinde dogrulanabilen yontemler. Kart ve DBS saha
    /// tahsilatinda kullanilamaz; sunucu da bunu reddeder.
    static var sahaYontemleri: [PaymentMethod] { [.cash, .cheque, .promissoryNote] }
}

struct PaymentView: Codable, Sendable, Identifiable {
    let id: String
    let companyTitle: String
    let methodLabel: String
    let statusLabel: String
    let amount: Double
    let currency: String
    let receivedAt: String
}

// MARK: Bayi portfoyu

struct CompanyListItem: Codable, Sendable, Identifiable {
    let id: String
    let title: String
    let logoCariCode: String
    let city: String?
    let phone: String?
    let isBlocked: Bool
    let balance: Double?
    let overdueAmount: Double?
    let currency: String
    let lastOrderAt: String?
    let lastVisitAt: String?
}

struct CompanyPage: Codable, Sendable {
    let companies: [CompanyListItem]
    let totalCount: Int
    let hasMore: Bool
}
