/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati
 * Date : 05/22/2026
 *
 * PO-to-Payment Visual Trace by Vendor
 *
 * Deploy this Suitelet and open it with an optional vendor parameter:
 *   &vendor=123
 *   &recordId=123
 *
 * It shows Purchase Orders for the selected vendor, then traces:
 *   PO -> Item Receipts -> Vendor Bills -> Vendor Payments
 */
define(['N/ui/serverWidget', 'N/search', 'N/runtime', 'N/url', 'N/record'], (
  serverWidget,
  search,
  runtime,
  url,
  record
) => {
  const FILTER_VALUE_CHUNK_SIZE = 900;

  const onRequest = (context) => {
    const request = context.request;
    const response = context.response;

    let vendorId = getVendorId(request.parameters);
    const poTextFilter = getPoTextFilter(request.parameters);
    const inferredVendorId = !vendorId && poTextFilter ? findVendorIdByPoNumber(poTextFilter) : '';
    const effectivePoTextFilter = inferredVendorId ? '' : poTextFilter;
    vendorId = vendorId || inferredVendorId;

    const form = serverWidget.createForm({
      title: 'PO to Payment Visual Trace'
    });

    form.addFieldGroup({ id: 'custpage_filters', label: 'Filters' });

    const vendorField = form.addField({
      id: 'custpage_vendor',
      type: serverWidget.FieldType.SELECT,
      label: 'Vendor',
      source: 'vendor',
      container: 'custpage_filters'
    });
    vendorField.defaultValue = vendorId;

    const poField = form.addField({
      id: 'custpage_po',
      type: serverWidget.FieldType.TEXT,
      label: 'PO Number Contains',
      container: 'custpage_filters'
    });
    poField.defaultValue = effectivePoTextFilter;

    form.addSubmitButton({ label: 'Show PO Flow' });

    if (request.method === 'POST') {
      const suiteletUrl = url.resolveScript({
        scriptId: runtime.getCurrentScript().id,
        deploymentId: runtime.getCurrentScript().deploymentId,
        params: {
          vendor: vendorId,
          po: effectivePoTextFilter
        }
      });
      response.sendRedirect({ type: 'EXTERNAL', identifier: suiteletUrl });
      return;
    }

    const htmlField = form.addField({
      id: 'custpage_visual_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'PO Flow'
    });
    htmlField.updateLayoutType({ layoutType: serverWidget.FieldLayoutType.OUTSIDEBELOW });
    htmlField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });

    if (!vendorId) {
      htmlField.defaultValue = buildEmptyState('Select a vendor and click Show PO Flow.');
      response.writePage(form);
      return;
    }

    const data = getPoPaymentTrace({ vendorId, poTextFilter: effectivePoTextFilter });
    htmlField.defaultValue = buildHtml(data);

    response.writePage(form);
  };

  function getPoPaymentTrace({ vendorId, poTextFilter }) {
    const poRows = searchPurchaseOrders(vendorId, poTextFilter);
    const poIds = poRows.map((p) => p.id);

    if (!poIds.length) return [];

    const receiptsByPo = searchReceiptsByPo(poIds);
    const billsByPo = searchBillsByPo(poIds);
    const paymentsByBill = searchPaymentsByBill(flatten(Object.values(billsByPo)).map((b) => b.id));

    return poRows.map((po) => {
      const receipts = receiptsByPo[po.id] || [];
      const bills = billsByPo[po.id] || [];

      return {
        id: po.id,
        tranid: po.tranid,
        entity: po.entity,
        date: po.date,
        amount: po.amount,
        status: po.status,
        receipts,
        bills: bills.map((bill) => ({
          ...bill,
          payments: paymentsByBill[bill.id] || []
        }))
      };
    });
  }

  function getVendorId(params) {
    return String(
      params.custpage_vendor ||
      params.vendor ||
      params.vendorid ||
      params.entity ||
      params.recordId ||
      params.recordid ||
      params.id ||
      ''
    ).trim();
  }

  function getPoTextFilter(params) {
    return String(
      params.custpage_po ||
      params.po ||
      params.ponumber ||
      params.tranid ||
      ''
    ).trim();
  }

  function findVendorIdByPoNumber(poTextFilter) {
    return searchPoVendor(poTextFilter, 'is') || searchPoVendor(poTextFilter, 'contains');
  }

  function searchPoVendor(poTextFilter, operator) {
    const s = search.create({
      type: search.Type.TRANSACTION,
      filters: [
        ['type', 'anyof', 'PurchOrd'],
        'AND', ['mainline', 'is', 'T'],
        'AND', ['tranid', operator, poTextFilter]
      ],
      columns: [
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        'entity'
      ]
    });

    const rows = s.run().getRange({ start: 0, end: 1 });
    return rows && rows.length ? String(rows[0].getValue('entity') || '').trim() : '';
  }

  function searchPurchaseOrders(vendorId, poTextFilter) {
    const filters = [
      ['type', 'anyof', 'PurchOrd'],
      'AND', ['mainline', 'is', 'T'],
      'AND', ['entity', 'anyof', vendorId]
    ];

    if (poTextFilter) {
      filters.push('AND', ['tranid', 'contains', poTextFilter]);
    }

    const s = search.create({
      type: search.Type.TRANSACTION,
      filters,
      columns: [
        'internalid',
        'tranid',
        'entity',
        'trandate',
        'amount',
        'statusref'
      ]
    });

    return getAll(s).map((r) => ({
      id: r.getValue('internalid'),
      recordType: record.Type.PURCHASE_ORDER,
      tranid: r.getValue('tranid'),
      entity: r.getText('entity'),
      date: r.getValue('trandate'),
      amount: r.getValue('amount'),
      status: r.getText('statusref') || r.getValue('statusref')
    }));
  }

  function searchReceiptsByPo(poIds) {
    if (!poIds.length) return {};

    const out = {};
    chunkValues(poIds).forEach((ids) => {
      const s = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'ItemRcpt'],
          'AND', ['mainline', 'is', 'T'],
          'AND', ['createdfrom', 'anyof', ids]
        ],
        columns: [
          'internalid',
          'tranid',
          'createdfrom',
          'trandate',
          'statusref'
        ]
      });

      getAll(s).forEach((r) => {
        const poId = r.getValue('createdfrom');
        if (!out[poId]) out[poId] = [];
        out[poId].push({
          id: r.getValue('internalid'),
          recordType: record.Type.ITEM_RECEIPT,
          tranid: r.getValue('tranid'),
          date: r.getValue('trandate'),
          status: r.getText('statusref') || r.getValue('statusref')
        });
      });
    });
    return out;
  }

  function searchBillsByPo(poIds) {
    if (!poIds.length) return {};

    const out = {};
    chunkValues(poIds).forEach((ids) => {
      const s = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'VendBill'],
          'AND', ['mainline', 'is', 'T'],
          'AND', ['createdfrom', 'anyof', ids]
        ],
        columns: [
          'internalid',
          'tranid',
          'createdfrom',
          'trandate',
          'amount',
          'amountremaining',
          'statusref'
        ]
      });

      getAll(s).forEach((r) => {
        const poId = r.getValue('createdfrom');
        if (!out[poId]) out[poId] = [];
        out[poId].push({
          id: r.getValue('internalid'),
          recordType: record.Type.VENDOR_BILL,
          tranid: r.getValue('tranid'),
          date: r.getValue('trandate'),
          amount: r.getValue('amount'),
          amountRemaining: r.getValue('amountremaining'),
          status: r.getText('statusref') || r.getValue('statusref')
        });
      });
    });
    return out;
  }

  function searchPaymentsByBill(billIds) {
    if (!billIds.length) return {};

    /*
     * Uses the Applied To Transaction join from Vendor Payment to Vendor Bill.
     * In some NetSuite accounts, the field id may need adjustment depending on
     * enabled features/customization. If this returns blank, verify the payment
     * search join in your account's Saved Search UI.
     */
    const out = {};
    chunkValues(billIds).forEach((ids) => {
      const s = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'VendPymt'],
          'AND', ['mainline', 'is', 'T'],
          'AND', ['appliedtotransaction', 'anyof', ids]
        ],
        columns: [
          'internalid',
          'tranid',
          'trandate',
          'amount',
          'statusref',
          'appliedtotransaction'
        ]
      });

      getAll(s).forEach((r) => {
        const billId = r.getValue('appliedtotransaction');
        if (!out[billId]) out[billId] = [];
        out[billId].push({
          id: r.getValue('internalid'),
          recordType: record.Type.VENDOR_PAYMENT,
          tranid: r.getValue('tranid'),
          date: r.getValue('trandate'),
          amount: r.getValue('amount'),
          status: r.getText('statusref') || r.getValue('statusref')
        });
      });
    });
    return out;
  }

  function getAll(searchObj, limit) {
    const results = [];
    const paged = searchObj.runPaged({ pageSize: 1000 });
    for (let i = 0; i < paged.pageRanges.length; i++) {
      const page = paged.fetch({ index: i });
      for (let j = 0; j < page.data.length; j++) {
        results.push(page.data[j]);
        if (limit && results.length >= limit) return results;
      }
    }
    return results;
  }

  function flatten(arrays) {
    return arrays.reduce((acc, arr) => acc.concat(arr), []);
  }

  function chunkValues(values) {
    const chunks = [];
    for (let i = 0; i < values.length; i += FILTER_VALUE_CHUNK_SIZE) {
      chunks.push(values.slice(i, i + FILTER_VALUE_CHUNK_SIZE));
    }
    return chunks;
  }

  function buildHtml(poFlows) {
    if (!poFlows.length) {
      return buildEmptyState('No purchase orders found for the selected vendor.');
    }

    const stats = getTraceStats(poFlows);
    const rows = poFlows.map(renderPoFlow).join('');

    return `
      <style>
        .pq-wrap { color: #172033; font-family: Arial, Helvetica, sans-serif; padding: 14px 0 28px; }
        .pq-dashboard-head { align-items: flex-end; background: #f8fafc; border: 1px solid #dfe6ef; border-radius: 8px; box-sizing: border-box; display: flex; gap: 18px; justify-content: space-between; margin: 2px 0 14px; padding: 14px 16px; }
        .pq-eyebrow { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: 0; margin-bottom: 4px; text-transform: uppercase; }
        .pq-title { color: #111827; font-size: 22px; font-weight: 800; line-height: 1.2; }
        .pq-subtitle { color: #52627a; font-size: 12px; margin-top: 5px; }
        .pq-metrics { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
        .pq-metric { background: #fff; border: 1px solid #dbe4f0; border-radius: 8px; min-width: 72px; padding: 8px 10px; text-align: right; }
        .pq-metric-value { color: #111827; display: block; font-size: 20px; font-weight: 800; line-height: 1; }
        .pq-metric-label { color: #64748b; display: block; font-size: 10px; font-weight: 700; line-height: 1; margin-top: 6px; text-transform: uppercase; }
        .pq-flow { background: #fff; border: 1px solid #dfe6ef; border-radius: 8px; box-shadow: 0 1px 4px rgba(15, 23, 42, .06); margin: 0 0 14px; overflow-x: auto; width: 100%; }
        .pq-flow-head { align-items: center; background: #fbfcfe; border-bottom: 1px solid #edf1f6; display: flex; gap: 14px; justify-content: space-between; min-width: 1240px; padding: 12px 16px; }
        .pq-flow-title { align-items: baseline; display: flex; flex-wrap: wrap; gap: 8px; }
        .pq-flow-link { color: #175abc; font-size: 18px; font-weight: 800; text-decoration: none; }
        .pq-type { color: #64748b; font-size: 12px; font-weight: 700; text-transform: uppercase; }
        .pq-flow-meta { color: #52627a; display: flex; flex-wrap: wrap; font-size: 12px; gap: 8px 18px; margin-top: 5px; }
        .pq-status { background: #eef6ff; border: 1px solid #bfdbfe; border-radius: 999px; color: #175abc; font-size: 12px; font-weight: 800; padding: 6px 10px; white-space: nowrap; }
        .pq-tree { align-items: center; box-sizing: border-box; display: grid; grid-template-columns: minmax(190px, .85fr) minmax(92px, .38fr) minmax(190px, .85fr) minmax(760px, 3fr); min-width: 1240px; padding: 22px 26px 24px; width: 100%; }
        .pq-tree-node-wrap { align-items: center; display: flex; flex-direction: column; }
        .pq-tree-arrow,
        .pq-lane-arrow { box-shadow: inset 0 -10px 18px rgba(15, 23, 42, .10); clip-path: polygon(0 0, calc(100% - 24px) 0, 100% 50%, calc(100% - 24px) 100%, 0 100%, 18px 50%); height: 48px; margin: 0 -8px; min-width: 84px; }
        .pq-tree-arrow-po { background: linear-gradient(90deg, #4ec4ea, #1f78ac); }
        .pq-lanes { display: flex; flex-direction: column; gap: 14px; padding-left: 8px; }
        .pq-lane { align-items: center; display: grid; grid-template-columns: minmax(112px, .7fr) minmax(210px, 1.2fr) minmax(112px, .7fr) minmax(210px, 1.2fr); min-height: 128px; }
        .pq-lane-arrow-bill { background: linear-gradient(90deg, #ffd15a, #ef8a16); }
        .pq-lane-arrow-pay { background: linear-gradient(90deg, #30d9c3, #6738d8); }
        .pq-lane-empty .pq-lane-arrow-bill,
        .pq-lane-empty .pq-lane-arrow-pay { background: linear-gradient(90deg, #e2e8f0, #cbd5e1); opacity: .78; }
        .pq-node { align-items: center; background: #fff; border: 2px solid #1c7aa4; border-radius: 8px; box-shadow: 0 8px 18px rgba(15, 23, 42, .08); box-sizing: border-box; display: flex; flex-direction: column; min-height: 112px; justify-content: center; margin: 0 auto; max-width: 260px; padding: 14px 16px; position: relative; text-align: center; width: 100%; z-index: 2; }
        .pq-node-po { border-color: #1f78ac; }
        .pq-node-receipt { border-color: #15803d; }
        .pq-node-bill { border-color: #d97706; }
        .pq-node-pay { border-color: #6738d8; }
        .pq-node-empty { background: #fbfcfe; border-color: #b8c3d4; border-style: dashed; box-shadow: 0 8px 18px rgba(15, 23, 42, .06); color: #64748b; }
        .pq-node-code { align-items: center; border-radius: 6px; color: #fff; display: flex; font-size: 12px; font-weight: 800; height: 28px; justify-content: center; letter-spacing: 0; margin-bottom: 7px; width: 34px; }
        .pq-node-po .pq-node-code { background: #1f78ac; }
        .pq-node-receipt .pq-node-code { background: #15803d; }
        .pq-node-bill .pq-node-code { background: #d97706; }
        .pq-node-pay .pq-node-code { background: #6738d8; }
        .pq-node-empty .pq-node-code { background: #94a3b8; }
        .pq-node-title { color: #0f172a; font-size: 14px; font-weight: 800; line-height: 1.2; }
        .pq-node-count { color: #64748b; font-size: 11px; font-weight: 700; margin-top: 3px; text-transform: uppercase; }
        .pq-node-links { color: #334155; font-size: 12px; line-height: 1.25; margin-top: 8px; max-width: 135px; overflow-wrap: anywhere; }
        .pq-node-links a { color: #175abc; font-weight: 800; text-decoration: none; }
        .pq-node-more { color: #64748b; font-size: 11px; font-weight: 700; margin-top: 3px; }
        .pq-stage-caption { color: #334155; font-size: 11px; font-weight: 800; letter-spacing: 0; margin-top: 8px; text-align: center; text-transform: uppercase; }
      </style>
      <div class="pq-wrap">
        <div class="pq-dashboard-head">
          <div>
            <div class="pq-eyebrow">Vendor Purchase Flow</div>
            <div class="pq-title">PO to Payment Trace</div>
            <div class="pq-subtitle">Showing ${poFlows.length} purchase order${poFlows.length === 1 ? '' : 's'} for the selected vendor.</div>
          </div>
          <div class="pq-metrics">
            <div class="pq-metric"><span class="pq-metric-value">${stats.poCount}</span><span class="pq-metric-label">POs</span></div>
            <div class="pq-metric"><span class="pq-metric-value">${stats.receiptCount}</span><span class="pq-metric-label">Receipts</span></div>
            <div class="pq-metric"><span class="pq-metric-value">${stats.billCount}</span><span class="pq-metric-label">Invoices</span></div>
            <div class="pq-metric"><span class="pq-metric-value">${stats.paymentCount}</span><span class="pq-metric-label">Payments</span></div>
          </div>
        </div>
        ${rows}
      </div>`;
  }

  function renderPoFlow(po) {
    const invoiceLanes = renderInvoiceLanes(po);

    return `
      <div class="pq-flow">
        <div class="pq-flow-head">
          <div>
            <div class="pq-flow-title">
              ${renderRecordLink(po, po.tranid, 'pq-flow-link')}
              <span class="pq-type">Purchase Order</span>
            </div>
            <div class="pq-flow-meta">
              <span>Vendor: ${escapeHtml(po.entity || '')}</span>
              <span>Date: ${escapeHtml(po.date || '')}</span>
              <span>Amount: ${escapeHtml(po.amount || '')}</span>
            </div>
          </div>
          <div class="pq-status">${escapeHtml(po.status || 'Status unavailable')}</div>
        </div>
        <div class="pq-tree">
          ${renderTreeNode({
            key: 'po',
            code: 'PO',
            title: 'Purchase Order',
            records: [po],
            emptyText: 'No PO'
          })}
          <div class="pq-tree-arrow pq-tree-arrow-po"></div>
          ${renderTreeNode({
            key: 'receipt',
            code: 'IR',
            title: 'Receipt',
            records: po.receipts,
            emptyText: 'No receipt'
          })}
          <div class="pq-lanes">
            ${invoiceLanes}
          </div>
        </div>
      </div>`;
  }

  function renderInvoiceLanes(po) {
    if (!po.bills.length) {
      return renderInvoiceLane(null, []);
    }

    return po.bills.map((bill) => renderInvoiceLane(bill, bill.payments || [])).join('');
  }

  function renderInvoiceLane(bill, payments) {
    const hasBill = !!bill;
    return `
      <div class="pq-lane ${hasBill ? '' : 'pq-lane-empty'}">
        <div class="pq-lane-arrow pq-lane-arrow-bill"></div>
        ${renderTreeNode({
          key: 'bill',
          code: 'VB',
          title: 'Invoice',
          records: hasBill ? [bill] : [],
          emptyText: 'No invoice'
        })}
        <div class="pq-lane-arrow pq-lane-arrow-pay"></div>
        ${renderTreeNode({
          key: 'pay',
          code: 'VP',
          title: 'Payment',
          records: payments,
          emptyText: 'No payment'
        })}
      </div>`;
  }

  function renderTreeNode({ key, code, title, records, emptyText }) {
    const hasRecords = records && records.length;
    const countText = hasRecords
      ? `${records.length} ${records.length === 1 ? 'record' : 'records'}`
      : 'Missing';

    return `
      <div class="pq-tree-node-wrap">
        <div class="pq-node pq-node-${escapeHtml(key)} ${hasRecords ? '' : 'pq-node-empty'}">
          <div class="pq-node-code">${escapeHtml(code)}</div>
          <div class="pq-node-title">${escapeHtml(title)}</div>
          <div class="pq-node-count">${escapeHtml(countText)}</div>
          <div class="pq-node-links">${renderNodeRecordLinks(records, emptyText)}</div>
        </div>
        <div class="pq-stage-caption">${escapeHtml(title)}</div>
      </div>`;
  }

  function renderNodeRecordLinks(records, emptyText) {
    if (!records || !records.length) {
      return escapeHtml(emptyText || 'No linked transaction');
    }

    const shown = records.slice(0, 3).map((rec) => {
      const number = rec.tranid || rec.id || 'Open';
      return `<div>${renderRecordLink(rec, number)}</div>`;
    }).join('');
    const moreCount = records.length - 3;
    const more = moreCount > 0 ? `<div class="pq-node-more">+${moreCount} more</div>` : '';
    return shown + more;
  }

  function getTraceStats(poFlows) {
    return poFlows.reduce((stats, po) => {
      const payments = flatten(po.bills.map((b) => b.payments || []));
      stats.poCount += 1;
      stats.receiptCount += po.receipts.length;
      stats.billCount += po.bills.length;
      stats.paymentCount += payments.length;
      return stats;
    }, {
      poCount: 0,
      receiptCount: 0,
      billCount: 0,
      paymentCount: 0
    });
  }

  function renderRecordLink(rec, text, className) {
    const linkClass = className ? ` class="${escapeHtml(className)}"` : '';
    const href = rec && rec.id && rec.recordType ? transactionUrl(rec.recordType, rec.id) : '';
    return href
      ? `<a${linkClass} href="${escapeHtml(href)}" target="_blank">${escapeHtml(text)}</a>`
      : escapeHtml(text);
  }

  function transactionUrl(recordType, id) {
    return url.resolveRecord({
      recordType,
      recordId: id,
      isEditMode: false
    });
  }

  function buildEmptyState(message) {
    return `
      <style>
        .pq-empty { background: #f8fafc; border: 1px solid #dfe6ef; border-radius: 8px; color: #475569; font-family: Arial, Helvetica, sans-serif; margin: 16px 0; padding: 22px 24px; }
        .pq-empty-title { color: #111827; font-size: 16px; font-weight: 800; margin-bottom: 4px; }
        .pq-empty-text { font-size: 13px; }
      </style>
      <div class="pq-empty">
        <div class="pq-empty-title">PO to Payment Trace</div>
        <div class="pq-empty-text">${escapeHtml(message)}</div>
      </div>`;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return { onRequest };
});
