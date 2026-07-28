import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { financialYearLabel } from '@intoto/shared';

import { PrismaService } from '../prisma/prisma.service';

/**
 * Gap-free document numbering.
 *
 * GST law requires invoice series to be consecutive and unbroken within a financial
 * year. That rules out the obvious implementations:
 *
 *  - `count() + 1` races under concurrent billing and reuses numbers.
 *  - A Postgres sequence leaves gaps whenever a transaction rolls back.
 *
 * So the counter lives in a row that is locked and incremented inside the *same*
 * transaction as the document it numbers. If the document rolls back, so does the
 * counter, and the series stays intact.
 *
 * Format: INTOTO/SHOP1/INV/2025-26/00001
 */

export type DocumentType =
  | 'SALES_INVOICE'
  | 'SALES_RETURN'
  | 'CREDIT_NOTE'
  | 'PURCHASE_ORDER'
  | 'PURCHASE_REQUISITION'
  | 'GOODS_RECEIPT'
  | 'PURCHASE_BILL'
  | 'PURCHASE_RETURN'
  | 'DEBIT_NOTE'
  | 'STOCK_TRANSFER'
  | 'STOCK_ADJUSTMENT'
  | 'CYCLE_COUNT'
  | 'PAYMENT_VOUCHER'
  | 'RECEIPT_VOUCHER'
  | 'JOURNAL_ENTRY'
  | 'EXPENSE'
  | 'CUSTOMER'
  | 'SUPPLIER'
  | 'EMPLOYEE'
  | 'POS_SESSION';

const DEFAULT_PREFIX: Record<DocumentType, string> = {
  SALES_INVOICE: 'INV',
  SALES_RETURN: 'SRN',
  CREDIT_NOTE: 'CRN',
  PURCHASE_ORDER: 'PO',
  PURCHASE_REQUISITION: 'PR',
  GOODS_RECEIPT: 'GRN',
  PURCHASE_BILL: 'BILL',
  PURCHASE_RETURN: 'PRN',
  DEBIT_NOTE: 'DBN',
  STOCK_TRANSFER: 'TRF',
  STOCK_ADJUSTMENT: 'ADJ',
  CYCLE_COUNT: 'CNT',
  PAYMENT_VOUCHER: 'PAY',
  RECEIPT_VOUCHER: 'RCT',
  JOURNAL_ENTRY: 'JV',
  EXPENSE: 'EXP',
  CUSTOMER: 'CUS',
  SUPPLIER: 'SUP',
  EMPLOYEE: 'EMP',
  POS_SESSION: 'POS',
};

@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserve the next number. MUST be called inside the transaction that writes the
   * document — pass the transaction client as `tx`.
   */
  async next(
    tx: Prisma.TransactionClient,
    params: {
      organizationId: string;
      documentType: DocumentType;
      shopId?: string | null;
      shopCode?: string | null;
      date?: Date;
      orgCode?: string;
    },
  ): Promise<string> {
    const date = params.date ?? new Date();
    const financialYear = financialYearLabel(date);
    // '' is the organization-wide series. See the note on NumberSequence.shopId.
    const shopId = params.shopId ?? '';

    // Look up the counter, then increment it atomically. Postgres holds the row lock for
    // the duration of the enclosing transaction, so concurrent billing at two counters
    // serialises here rather than colliding.
    const existing = await tx.numberSequence.findUnique({
      where: {
        organizationId_shopId_documentType_financialYear: {
          organizationId: params.organizationId,
          shopId,
          documentType: params.documentType,
          financialYear,
        },
      },
    });

    const prefix = existing?.prefix ?? DEFAULT_PREFIX[params.documentType];
    const padding = existing?.padding ?? 5;

    const sequence = existing
      ? await tx.numberSequence.update({
          where: { id: existing.id },
          data: { lastNumber: { increment: 1 } },
        })
      : await tx.numberSequence.create({
          data: {
            organizationId: params.organizationId,
            shopId,
            documentType: params.documentType,
            financialYear,
            prefix,
            lastNumber: 1,
            padding,
          },
        });

    const serial = String(sequence.lastNumber).padStart(padding, '0');
    return [
      params.orgCode ?? 'INTOTO',
      params.shopCode ?? undefined,
      prefix,
      financialYear,
      serial,
    ]
      .filter(Boolean)
      .join('/');
  }

  /**
   * Peek at the next number without consuming it — for showing "this bill will be
   * INV/…/00042" on a draft screen. Never use the result to actually number a document.
   */
  async preview(params: {
    organizationId: string;
    documentType: DocumentType;
    shopId?: string | null;
    shopCode?: string | null;
    date?: Date;
  }): Promise<string> {
    const date = params.date ?? new Date();
    const financialYear = financialYearLabel(date);
    const existing = await this.prisma.numberSequence.findUnique({
      where: {
        organizationId_shopId_documentType_financialYear: {
          organizationId: params.organizationId,
          shopId: params.shopId ?? '',
          documentType: params.documentType,
          financialYear,
        },
      },
    });
    const prefix = existing?.prefix ?? DEFAULT_PREFIX[params.documentType];
    const padding = existing?.padding ?? 5;
    const serial = String((existing?.lastNumber ?? 0) + 1).padStart(padding, '0');
    return ['INTOTO', params.shopCode ?? undefined, prefix, financialYear, serial]
      .filter(Boolean)
      .join('/');
  }
}
