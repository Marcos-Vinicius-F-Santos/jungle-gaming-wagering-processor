import Decimal from 'decimal.js';

const FALLBACK_ISO_4217_CODES = [
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV',
  'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHE', 'CHF',
  'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUC', 'CUP', 'CVE',
  'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD',
  'FKP', 'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD',
  'HNL', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK', 'JMD',
  'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD',
  'KZT', 'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA',
  'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV',
  'MYR', 'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB',
  'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR', 'RON', 'RSD', 'RUB',
  'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SOS',
  'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND',
  'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD', 'USN', 'UYI',
  'UYU', 'UYW', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XAG',
  'XAU', 'XBA', 'XBB', 'XBC', 'XBD', 'XCD', 'XDR', 'XOF', 'XPD', 'XPF',
  'XPT', 'XSU', 'XTS', 'XUA', 'XXX', 'YER', 'ZAR', 'ZMW', 'ZWL',
] as const;

const supportedCurrencyCodes = new Set<string>(
  typeof (Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === 'function'
    ? (Intl as typeof Intl & { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('currency')
    : FALLBACK_ISO_4217_CODES,
);

const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
const MAX_INTEGER_DIGITS = 17;

export class Money {
  private constructor(
    public readonly amount: string,
    public readonly currency: string,
  ) {}

  static of(amount: string, currency: string): Money {
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new Error('money amount must be a non-negative decimal string with at most two fraction digits');
    }

    const normalizedCurrency = typeof currency === 'string' ? currency.toUpperCase() : '';
    if (!isIso4217Currency(normalizedCurrency)) {
      throw new Error('money currency must be a valid ISO-4217 code');
    }

    const integerPart = amount.split('.')[0];
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new Error('money amount exceeds NUMERIC(19,2) precision');
    }

    const normalizedAmount = new Decimal(amount).toFixed(2);
    return new Money(normalizedAmount, normalizedCurrency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(new Decimal(this.amount).plus(other.amount).toFixed(2), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(new Decimal(this.amount).minus(other.amount).toFixed(2), this.currency);
  }

  isZero(): boolean {
    return this.amount === '0.00';
  }

  isPositive(): boolean {
    return !this.isZero();
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.amount, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error('money currencies must match');
    }
  }
}

export function isIso4217Currency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(currency) && supportedCurrencyCodes.has(currency);
}
