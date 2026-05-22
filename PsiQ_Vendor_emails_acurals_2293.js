/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
  'N/ui/serverWidget',
  'N/search',
  'N/email',
  'N/runtime',
  'N/format',
  'N/file',
  'N/url'
], (ui, search, email, runtime, format, file, url) => {

  const STATUS_CLOSED = 'PurchOrd:H';
  const ITEM_TYPE_NON_INVENTORY = 'NonInvtPart';

  const PARAM_TEST_MODE = 'custscript_email_test_mode';
  const PARAM_TEST_SEND_EMPLOYEE = 'custscript_sent_email_address';
  const PARAM_TEST_RECIPIENT_EMPLOYEE = 'custscript_rept_email_address';

  const PAGE_SIZE_CLIENT = 20;
  const HIGH_VALUE_THRESHOLD = 10000;

  function onRequest(context) {
    const action = context.request.parameters.custpage_action || 'search';

    if (context.request.method === 'POST' && action === 'send') {
      sendEmails(context);
      return;
    }

    render(context);
  }

  function render(context) {
    const req = context.request;
    const form = ui.createForm({ title: 'Open Purchase Orders - Vendor Follow-up' });

    const today = new Date();
    const from = new Date();
    from.setDate(today.getDate() - 120);

    const fromDate = req.parameters.custpage_fromdate || fmtDate(from);
    const toDate = req.parameters.custpage_todate || fmtDate(today);
    const poNumber = cleanPoNumber(req.parameters.custpage_ponumber || '');
    const successMsg = req.parameters.custpage_success_msg || '';

    form.addSubmitButton({ label: 'Search / Refresh' });

    addHiddenField(form, 'custpage_action', 'Action', 'search');
    addHiddenField(form, 'custpage_selected_po_ids', 'Selected PO IDs', '');
    addHiddenField(form, 'custpage_ponumber', 'PO Number Hidden', poNumber);
    addHiddenField(form, 'custpage_fromdate', 'From Date Hidden', fromDate);
    addHiddenField(form, 'custpage_todate', 'To Date Hidden', toDate);

    const rows = getPoLines({ fromDate, toDate, poNumber, poIds: null });
    const grouped = groupByVendor(rows);
    const stats = buildStats(rows, grouped);

    form.addField({
      id: 'custpage_html',
      label: 'Workbench',
      type: ui.FieldType.INLINEHTML
    }).defaultValue = buildPageHtml({
      grouped,
      stats,
      fromDate,
      toDate,
      poNumber,
      successMsg
    });

    context.response.writePage(form);
  }

  function addHiddenField(form, id, label, value) {
    const fld = form.addField({
      id,
      label,
      type: id === 'custpage_selected_po_ids' ? ui.FieldType.LONGTEXT : ui.FieldType.TEXT
    });
    fld.defaultValue = value || '';
    fld.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
    return fld;
  }

  function getPoLines(opts) {
    const filters = [
      ['type', 'anyof', 'PurchOrd'],
      'AND', ['mainline', 'is', 'F'],
      'AND', ['taxline', 'is', 'F'],
      'AND', ['shipping', 'is', 'F'],
      'AND', ['cogs', 'is', 'F'],
      'AND', ['status', 'noneof', STATUS_CLOSED],
      'AND', ['item.type', 'noneof', ITEM_TYPE_NON_INVENTORY]
    ];

    if (opts.poIds && opts.poIds.length) {
      filters.push('AND', ['internalid', 'anyof', opts.poIds]);
    } else if (opts.poNumber) {
      filters.push('AND', ['tranid', 'is', cleanPoNumber(opts.poNumber)]);
    } else {
      filters.push('AND', ['trandate', 'within', opts.fromDate, opts.toDate]);
    }

    const colInternalId = search.createColumn({ name: 'internalid', sort: search.Sort.DESC });
    const colTranId = search.createColumn({ name: 'tranid' });
    const colTranDate = search.createColumn({ name: 'trandate' });
    const colStatus = search.createColumn({ name: 'statusref' });
    const colItem = search.createColumn({ name: 'item' });
    const colMemo = search.createColumn({ name: 'memo' });
    const colQty = search.createColumn({ name: 'quantity' });
    const colReceived = search.createColumn({ name: 'quantityshiprecv' });
    const colExpected = search.createColumn({ name: 'expectedreceiptdate' });
    const colAmount = search.createColumn({ name: 'amount' });

    const poSearch = search.create({
      type: search.Type.PURCHASE_ORDER,
      filters,
      columns: [
        colInternalId,
        colTranId,
        colTranDate,
        colStatus,
        colItem,
        colMemo,
        colQty,
        colReceived,
        colExpected,
        colAmount
      ]
    });

    const rows = [];
    const poIds = {};
    const paged = poSearch.runPaged({ pageSize: 1000 });

    paged.pageRanges.forEach(range => {
      const page = paged.fetch({ index: range.index });

      page.data.forEach(r => {
        const poId = r.getValue(colInternalId);
        poIds[poId] = true;

        const qty = Number(r.getValue(colQty) || 0);
        const received = Number(r.getValue(colReceived) || 0);
        const amount = Number(r.getValue(colAmount) || 0);

        rows.push({
          poId,
          poNumber: r.getValue(colTranId),
          poDate: r.getValue(colTranDate),
          status: r.getText(colStatus) || r.getValue(colStatus),
          vendorId: '',
          vendorName: 'Vendor Not Available',
          vendorEmail: '',
          item: r.getText(colItem) || r.getValue(colItem),
          memo: r.getValue(colMemo),
          qty,
          received,
          openQty: qty - received,
          expectedDate: r.getValue(colExpected),
          amount
        });
      });
    });

    const headerMap = getPoHeaderMap(Object.keys(poIds));

    rows.forEach(r => {
      const h = headerMap[r.poId];
      if (h) {
        r.vendorId = h.vendorId;
        r.vendorName = h.vendorName;
        r.vendorEmail = h.vendorEmail;
        r.poUrl = h.poUrl;
      }
    });

    return rows;
  }

  function getPoHeaderMap(poIds) {
    const map = {};
    if (!poIds || !poIds.length) return map;

    for (let i = 0; i < poIds.length; i += 1000) {
      const batch = poIds.slice(i, i + 1000);

      const colInternalId = search.createColumn({ name: 'internalid' });
      const colEntity = search.createColumn({ name: 'entity' });
      const colVendorEmail = search.createColumn({ name: 'email', join: 'vendor' });
      const colVendorCompany = search.createColumn({ name: 'companyname', join: 'vendor' });
      const colVendorEntityId = search.createColumn({ name: 'entityid', join: 'vendor' });

      const headerSearch = search.create({
        type: search.Type.PURCHASE_ORDER,
        filters: [
          ['internalid', 'anyof', batch],
          'AND',
          ['mainline', 'is', 'T']
        ],
        columns: [
          colInternalId,
          colEntity,
          colVendorEmail,
          colVendorCompany,
          colVendorEntityId
        ]
      });

      headerSearch.run().each(r => {
        const poId = r.getValue(colInternalId);

        map[poId] = {
          vendorId: r.getValue(colEntity),
          vendorName:
            r.getText(colEntity) ||
            r.getValue(colVendorCompany) ||
            r.getValue(colVendorEntityId) ||
            'Vendor Not Available',
          vendorEmail: r.getValue(colVendorEmail),
          poUrl: url.resolveRecord({
            recordType: 'purchaseorder',
            recordId: poId,
            isEditMode: false
          })
        };

        return true;
      });
    }

    return map;
  }

  function groupByVendor(rows) {
    const vendorMap = {};

    rows.forEach(r => {
      const key = r.vendorId || 'missing_vendor';

      if (!vendorMap[key]) {
        vendorMap[key] = {
          vendorId: r.vendorId,
          vendorName: r.vendorName,
          vendorEmail: r.vendorEmail,
          poMap: {},
          lineCount: 0,
          amount: 0
        };
      }

      if (!vendorMap[key].poMap[r.poId]) {
        vendorMap[key].poMap[r.poId] = {
          poId: r.poId,
          poNumber: r.poNumber,
          poDate: r.poDate,
          status: r.status,
          poUrl: r.poUrl,
          vendorId: r.vendorId,
          vendorName: r.vendorName,
          vendorEmail: r.vendorEmail,
          lines: [],
          amount: 0
        };
      }

      vendorMap[key].poMap[r.poId].lines.push(r);
      vendorMap[key].poMap[r.poId].amount += Number(r.amount || 0);
      vendorMap[key].lineCount++;
      vendorMap[key].amount += Number(r.amount || 0);
    });

    return Object.values(vendorMap).map(v => {
      v.pos = Object.values(v.poMap);
      delete v.poMap;
      return v;
    });
  }

  function buildStats(rows, grouped) {
    const poIds = {};
    let totalOpenAmount = 0;
    let overdueLines = 0;
    const missingEmailVendors = {};
    const today = stripTime(new Date());

    rows.forEach(r => {
      poIds[r.poId] = true;
      totalOpenAmount += Number(r.amount || 0);

      if (r.expectedDate && parseNsDate(r.expectedDate) < today && Number(r.openQty || 0) > 0) {
        overdueLines++;
      }

      if (!r.vendorEmail) {
        missingEmailVendors[r.vendorId || r.vendorName] = true;
      }
    });

    return {
      poCount: Object.keys(poIds).length,
      vendorCount: grouped.length,
      lineCount: rows.length,
      totalOpenAmount,
      overdueLines,
      missingEmailVendorCount: Object.keys(missingEmailVendors).length
    };
  }

  function buildPageHtml(data) {
    return `
${buildCss()}
${data.successMsg ? `<div class="success-banner">${esc(data.successMsg)}</div>` : ''}

<div class="workbench">
  ${buildKpiHtml(data.stats)}
  ${buildFilterHtml(data.poNumber, data.fromDate, data.toDate)}
  ${buildStickyToolbarHtml()}
  ${buildVendorGroupsHtml(data.grouped)}
</div>

${buildPreviewModalHtml()}
${buildScriptHtml()}
`;
  }

  function buildKpiHtml(stats) {
    return `
<div class="kpi-grid">
  <div class="kpi-card"><div class="kpi-value">${stats.poCount}</div><div class="kpi-label">Open POs</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.vendorCount}</div><div class="kpi-label">Vendors</div></div>
  <div class="kpi-card"><div class="kpi-value">${stats.lineCount}</div><div class="kpi-label">Lines</div></div>
  <div class="kpi-card"><div class="kpi-value">$${formatNumber(stats.totalOpenAmount)}</div><div class="kpi-label">Open Amount</div></div>
  <div class="kpi-card risk"><div class="kpi-value">${stats.overdueLines}</div><div class="kpi-label">Overdue Lines</div></div>
  <div class="kpi-card warn"><div class="kpi-value">${stats.missingEmailVendorCount}</div><div class="kpi-label">Missing Emails</div></div>
</div>`;
  }

  function buildFilterHtml(poNumber, fromDate, toDate) {
    return `
<div class="filter-panel">
  <div class="filter-field">
    <label>PO Number</label>
    <input type="text" id="ui_ponumber" value="${esc(poNumber)}">
  </div>
  <div class="filter-field">
    <label>From Date</label>
    <input type="text" id="ui_fromdate" value="${esc(fromDate)}">
  </div>
  <div class="filter-field">
    <label>To Date</label>
    <input type="text" id="ui_todate" value="${esc(toDate)}">
  </div>
  <div class="filter-field search-wide">
    <label>Instant Search</label>
    <input type="text" id="client_search" placeholder="Search vendor, PO, item, memo...">
  </div>
</div>`;
  }

  function buildStickyToolbarHtml() {
    return `
<div class="sticky-toolbar">
  <div>
    <div class="toolbar-title">Open PO Follow-up Queue</div>
    <div class="toolbar-sub"><span id="visible_count">0</span> visible · <span id="selected_count">0</span> selected</div>
  </div>
  <div class="toolbar-actions">
    <button type="button" class="btn btn-gray" onclick="toggleAll(true)">Select All Visible</button>
    <button type="button" class="btn btn-gray" onclick="toggleAll(false)">Clear</button>
    <button type="button" class="btn btn-gray" onclick="expandAll(true)">Expand All</button>
    <button type="button" class="btn btn-gray" onclick="expandAll(false)">Collapse All</button>
    <button type="button" class="btn btn-gray" onclick="exportVisibleCsv()">Export CSV</button>
    <button type="button" class="btn btn-gray" onclick="exportVisibleXls()">Export XLS</button>
    <button type="button" class="btn btn-gray" onclick="window.print()">Export PDF</button>
    <button type="button" class="btn btn-blue" onclick="openPreviewModal()">Email Queue Preview</button>
  </div>
</div>`;
  }

  function buildVendorGroupsHtml(grouped) {
    if (!grouped.length) {
      return `<div class="empty-state">No open PO lines found for the selected filters.</div>`;
    }

    return `
<div id="vendor_results">
  ${grouped.map((vendor, vendorIndex) => buildVendorGroupHtml(vendor, vendorIndex)).join('')}
</div>

<div class="load-more-wrap">
  <button type="button" class="btn btn-gray" id="load_more_btn" onclick="showMoreGroups()">Show More</button>
</div>`;
  }

  function buildVendorGroupHtml(vendor, vendorIndex) {
    const initial = esc((vendor.vendorName || '?').substring(0, 1).toUpperCase());

    return `
<section class="vendor-group" data-group-index="${vendorIndex}" data-search="${escAttr([
      vendor.vendorName,
      vendor.vendorEmail,
      vendor.pos.map(p => p.poNumber).join(' '),
      vendor.pos.map(p => p.lines.map(l => `${l.item} ${l.memo}`).join(' ')).join(' ')
    ].join(' ').toLowerCase())}">
  <div class="vendor-header" onclick="toggleVendorGroup('${vendorIndex}')">
    <div class="vendor-left">
      <div class="vendor-avatar">${initial}</div>
      <div>
        <div class="vendor-title">${esc(vendor.vendorName)}</div>
        <div class="vendor-meta">${vendor.vendorEmail ? esc(vendor.vendorEmail) : '<span class="err">Missing vendor email</span>'}</div>
      </div>
    </div>
    <div class="vendor-metrics">
      <span class="metric-pill">${vendor.pos.length} PO(s)</span>
      <span class="metric-pill">${vendor.lineCount} line(s)</span>
      <span class="metric-pill">$${formatNumber(vendor.amount)}</span>
    </div>
  </div>

  <div class="vendor-body" id="vendor_body_${vendorIndex}">
    ${vendor.pos.map(po => buildPoCardHtml(po)).join('')}
  </div>
</section>`;
  }

  function buildPoCardHtml(po) {
    const today = stripTime(new Date());
    const hasOverdue = po.lines.some(l => l.expectedDate && parseNsDate(l.expectedDate) < today && Number(l.openQty || 0) > 0);
    const highValue = Number(po.amount || 0) >= HIGH_VALUE_THRESHOLD;
    const missingEmail = !po.vendorEmail;

    return `
<div class="po-card" data-poid="${escAttr(po.poId)}" data-search="${escAttr([
      po.poNumber,
      po.vendorName,
      po.vendorEmail,
      po.status,
      po.lines.map(l => `${l.item} ${l.memo}`).join(' ')
    ].join(' ').toLowerCase())}">
  <div class="po-head">
    <input type="checkbox" class="po-check" data-poid="${escAttr(po.poId)}" ${po.vendorEmail ? '' : 'disabled'} onchange="refreshSelectionCount()">

    <div>
      <a class="po-no" href="${escAttr(po.poUrl || '#')}" target="_blank">${esc(po.poNumber)}</a>
      <div class="small">${esc(po.poDate)}</div>
    </div>

    <div>
      <div class="vendor-name">${esc(po.vendorName)}</div>
      ${po.vendorEmail ? `<span class="email">${esc(po.vendorEmail)}</span>` : `<span class="err">Missing vendor email</span>`}
    </div>

    <div>
      <span class="badge">${esc(po.status)}</span>
      ${hasOverdue ? `<span class="risk-chip">Overdue</span>` : ''}
      ${highValue ? `<span class="risk-chip high">High Value</span>` : ''}
      ${missingEmail ? `<span class="risk-chip missing">No Email</span>` : ''}
    </div>

    <div class="small">${po.lines.length} line(s)</div>

    <button type="button" class="btn btn-gray mini" onclick="togglePoBody(event, '${escAttr(po.poId)}')">Expand</button>
  </div>

  <div class="po-body collapsed" id="po_body_${escAttr(po.poId)}">
    <div class="dark-table-wrap">
      <div class="dark-table-title">Modern Dark Line Detail</div>
      <table class="po-lines dark-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Memo</th>
            <th>Qty</th>
            <th>Received</th>
            <th>Open Qty</th>
            <th>Expected Receipt</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          ${po.lines.map(l => buildLineRowHtml(l)).join('')}
        </tbody>
      </table>
    </div>
  </div>
</div>`;
  }

  function buildLineRowHtml(l) {
    const overdue = l.expectedDate && parseNsDate(l.expectedDate) < stripTime(new Date()) && Number(l.openQty || 0) > 0;

    return `
<tr class="${overdue ? 'line-overdue' : ''}">
  <td>${esc(l.item)}</td>
  <td>${esc(l.memo)}</td>
  <td>${l.qty}</td>
  <td>${l.received}</td>
  <td><b>${l.openQty}</b></td>
  <td>${esc(l.expectedDate || '')}${overdue ? '<span class="overdue-pill">Overdue</span>' : ''}</td>
  <td>${formatNumber(l.amount)}</td>
</tr>`;
  }

  function buildPreviewModalHtml() {
    return `
<div id="preview_modal" class="modal-backdrop">
  <div class="modal">
    <div class="modal-head">
      <div>
        <div class="modal-title">Email Queue Preview + Excel Attachment Preview</div>
        <div class="modal-sub">Review recipients, selected POs, and XLS preview before sending.</div>
      </div>
      <button type="button" class="modal-close" onclick="closePreviewModal()">×</button>
    </div>

    <div class="modal-tabs">
      <button type="button" class="tab-btn active" onclick="showModalTab('queue')">Email Queue</button>
      <button type="button" class="tab-btn" onclick="showModalTab('excel')">Expandable Excel Preview</button>
    </div>

    <div id="preview_queue" class="modal-body"></div>
    <div id="preview_excel" class="modal-body" style="display:none;"></div>

    <div class="modal-actions">
      <button type="button" class="btn btn-gray" onclick="closePreviewModal()">Cancel</button>
      <button type="button" class="btn btn-blue" onclick="submitSelected()">Confirm Send XLS Attachments</button>
    </div>
  </div>
</div>`;
  }

  function buildCss() {
    return `
<style>
.workbench{font-family:Arial,sans-serif;margin-top:14px;color:#24364b}
.success-banner{margin:12px 0 16px 0;padding:12px 16px;border:1px solid #86efac;background:#f0fdf4;color:#166534;border-radius:8px;font-family:Arial,sans-serif;font-weight:700}
.kpi-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:12px 0 16px}
.kpi-card{background:#fff;border:1px solid #dbe4f0;border-radius:14px;padding:14px 16px;box-shadow:0 1px 6px rgba(15,23,42,.06)}
.kpi-card.risk{border-color:#fecaca;background:#fff7f7}
.kpi-card.warn{border-color:#fed7aa;background:#fffaf5}
.kpi-value{font-size:22px;font-weight:800;color:#0f172a}
.kpi-label{font-size:12px;color:#64748b;margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
.filter-panel{display:grid;grid-template-columns:180px 180px 180px minmax(260px,1fr);gap:14px;align-items:end;margin:12px 0 16px}
.filter-field label{display:block;font-size:11px;color:#4f5f73;text-transform:uppercase;margin-bottom:4px}
.filter-field input{width:100%;height:30px;box-sizing:border-box;border:1px solid #bfc7d1;border-radius:6px;padding:4px 8px;font-size:13px}
.sticky-toolbar{position:sticky;top:8px;z-index:999;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;border:1px solid #cbd5e1;border-radius:14px;padding:12px 14px;margin-bottom:14px;box-shadow:0 8px 24px rgba(15,23,42,.08)}
.toolbar-title{font-size:18px;font-weight:800;color:#24364b}
.toolbar-sub{font-size:12px;color:#64748b;margin-top:3px}
.toolbar-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.btn{border:0;border-radius:8px;padding:9px 12px;font-weight:800;cursor:pointer}
.btn-blue{background:#2563eb;color:white}
.btn-gray{background:#e5e7eb;color:#111827}
.btn.mini{padding:6px 9px;font-size:11px}
.vendor-group{border:1px solid #dbe4f0;border-radius:14px;margin-bottom:16px;overflow:hidden;background:#fff;box-shadow:0 1px 6px rgba(15,23,42,.06)}
.vendor-header{display:flex;justify-content:space-between;align-items:center;background:#f8fafc;padding:14px 16px;cursor:pointer;border-bottom:1px solid #e2e8f0}
.vendor-left{display:flex;align-items:center;gap:12px}
.vendor-avatar{width:38px;height:38px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:16px}
.vendor-title{font-size:15px;font-weight:900;color:#0f172a}
.vendor-meta{font-size:12px;margin-top:2px;color:#2563eb}
.vendor-metrics{display:flex;gap:8px}
.metric-pill{background:#e0f2fe;color:#075985;border-radius:999px;padding:5px 10px;font-size:12px;font-weight:800}
.vendor-body{padding:10px}
.po-card{border:1px solid #dbe4f0;border-radius:12px;margin-bottom:10px;overflow:hidden;background:#fff;transition:.18s ease}
.po-card:hover{box-shadow:0 6px 18px rgba(15,23,42,.08)}
.po-head{display:grid;grid-template-columns:38px 1.1fr 2fr 1.6fr .8fr 90px;gap:12px;align-items:center;padding:12px 14px;background:#fff;border-bottom:1px solid #edf2f7}
.po-no{font-weight:900;color:#0f172a;text-decoration:none}
.po-no:hover{text-decoration:underline}
.vendor-name{font-weight:900;color:#111827}
.small{font-size:12px;color:#64748b}
.badge{display:inline-block;padding:4px 9px;border-radius:999px;background:#fff1e6;color:#a34100;font-weight:800;font-size:12px;margin-right:4px}
.email{color:#2563eb;font-size:12px}
.err{color:#b91c1c;font-weight:800;font-size:12px}
.risk-chip{display:inline-block;padding:4px 8px;border-radius:999px;background:#fee2e2;color:#b91c1c;font-size:11px;font-weight:900;margin:2px}
.risk-chip.high{background:#fef3c7;color:#92400e}
.risk-chip.missing{background:#f3f4f6;color:#374151}
.po-body.collapsed{display:none}
.dark-table-wrap{background:#0f172a;padding:12px;border-radius:0 0 12px 12px}
.dark-table-title{color:#e2e8f0;font-weight:900;margin-bottom:8px;font-size:13px;letter-spacing:.03em;text-transform:uppercase}
.dark-table{width:100%;border-collapse:collapse;background:#111827;color:#e5e7eb;border-radius:10px;overflow:hidden}
.dark-table th{font-size:11px;text-transform:uppercase;color:#93c5fd;text-align:left;padding:10px 12px;border-bottom:1px solid #334155;background:#1e293b}
.dark-table td{font-size:12px;color:#e5e7eb;padding:10px 12px;border-bottom:1px solid #273449}
.dark-table tr:hover td{background:#1f2937}
.dark-table .line-overdue td{background:#3f1d1d;color:#fee2e2}
.overdue-pill{display:inline-block;margin-left:8px;background:#fee2e2;color:#b91c1c;padding:3px 7px;border-radius:999px;font-size:10px;font-weight:900}
.empty-state{padding:28px;background:#f8fafc;border:1px solid #dbe4f0;border-radius:14px;text-align:center;font-weight:800;color:#64748b}
.load-more-wrap{text-align:center;margin:16px}
.modal-backdrop{display:none;position:fixed;z-index:2000;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,.52);align-items:center;justify-content:center}
.modal{width:980px;max-width:94vw;max-height:88vh;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.28)}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;background:#0f172a;border-bottom:1px solid #334155;color:white}
.modal-title{font-size:18px;font-weight:900;color:white}
.modal-sub{font-size:12px;color:#cbd5e1;margin-top:3px}
.modal-close{font-size:24px;border:0;background:transparent;cursor:pointer;color:white}
.modal-tabs{display:flex;gap:8px;background:#1e293b;padding:10px 16px}
.tab-btn{border:0;border-radius:8px;background:#334155;color:#e2e8f0;padding:8px 12px;font-weight:900;cursor:pointer}
.tab-btn.active{background:#2563eb;color:white}
.modal-body{padding:16px 20px;overflow:auto;max-height:56vh}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid #e2e8f0}
.preview-row{padding:12px;border:1px solid #e2e8f0;border-radius:10px;margin-bottom:10px;background:#f8fafc}
.preview-vendor{font-weight:900;color:#0f172a}
.preview-meta{font-size:12px;color:#64748b;margin-top:3px}
.preview-pill{display:inline-block;background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:900;margin-left:6px}
.excel-preview-group{border:1px solid #cbd5e1;border-radius:12px;margin-bottom:12px;overflow:hidden}
.excel-preview-head{background:#0f172a;color:white;padding:12px 14px;font-weight:900;cursor:pointer}
.excel-preview-body{display:none;background:#111827;padding:10px}
.excel-table{width:100%;border-collapse:collapse;color:#e5e7eb}
.excel-table th{background:#1e293b;color:#93c5fd;padding:9px;border:1px solid #334155;text-align:left;font-size:11px;text-transform:uppercase}
.excel-table td{padding:9px;border:1px solid #334155;font-size:12px}
@media print{.sticky-toolbar,.filter-panel,.btn,.modal-backdrop{display:none!important}.po-body.collapsed{display:block!important}}
</style>`;
  }

  function buildScriptHtml() {
    return `
<script>
var CLIENT_PAGE_SIZE = ${PAGE_SIZE_CLIENT};
var visibleLimit = CLIENT_PAGE_SIZE;

function syncFilters(){
  document.getElementById('custpage_ponumber').value = document.getElementById('ui_ponumber').value;
  document.getElementById('custpage_fromdate').value = document.getElementById('ui_fromdate').value;
  document.getElementById('custpage_todate').value = document.getElementById('ui_todate').value;
}

function initWorkbench(){
  ['ui_ponumber','ui_fromdate','ui_todate'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) el.addEventListener('input', syncFilters);
  });

  var search = document.getElementById('client_search');
  if(search) search.addEventListener('input', applyClientSearch);

  if(document.forms[0]){
    document.forms[0].addEventListener('submit', syncFilters);
  }

  applyClientSearch();
  refreshSelectionCount();
}

function applyClientSearch(){
  var q = (document.getElementById('client_search')?.value || '').toLowerCase();
  var groups = Array.from(document.querySelectorAll('.vendor-group'));
  var shown = 0;

  groups.forEach(function(group){
    var groupText = group.getAttribute('data-search') || '';
    var matchesGroup = !q || groupText.indexOf(q) >= 0;
    var withinLimit = shown < visibleLimit;

    if(matchesGroup && withinLimit){
      group.style.display = '';
      shown++;
    }else{
      group.style.display = 'none';
    }
  });

  document.getElementById('visible_count').textContent = shown;

  var loadBtn = document.getElementById('load_more_btn');
  if(loadBtn){
    var matchingTotal = groups.filter(function(g){
      var groupText = g.getAttribute('data-search') || '';
      return !q || groupText.indexOf(q) >= 0;
    }).length;
    loadBtn.style.display = shown < matchingTotal ? '' : 'none';
  }

  refreshSelectionCount();
}

function showMoreGroups(){
  visibleLimit += CLIENT_PAGE_SIZE;
  applyClientSearch();
}

function toggleVendorGroup(index){
  var body = document.getElementById('vendor_body_' + index);
  if(body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

function togglePoBody(event, poId){
  event.stopPropagation();
  var body = document.getElementById('po_body_' + poId);
  if(!body) return;
  body.classList.toggle('collapsed');
  event.target.textContent = body.classList.contains('collapsed') ? 'Expand' : 'Collapse';
}

function expandAll(flag){
  document.querySelectorAll('.po-body').forEach(function(body){
    body.classList.toggle('collapsed', !flag);
  });
  document.querySelectorAll('.po-card .mini').forEach(function(btn){
    btn.textContent = flag ? 'Collapse' : 'Expand';
  });
}

function toggleAll(flag){
  document.querySelectorAll('.vendor-group').forEach(function(group){
    if(group.style.display === 'none') return;
    group.querySelectorAll('.po-check:not(:disabled)').forEach(function(cb){
      cb.checked = flag;
    });
  });
  refreshSelectionCount();
}

function getSelectedIds(){
  return Array.from(document.querySelectorAll('.po-check:checked')).map(function(cb){
    return cb.getAttribute('data-poid');
  });
}

function refreshSelectionCount(){
  var count = getSelectedIds().length;
  var el = document.getElementById('selected_count');
  if(el) el.textContent = count;
}

function openPreviewModal(){
  var ids = getSelectedIds();

  if(!ids.length){
    alert('Please select at least one PO.');
    return;
  }

  buildQueuePreview();
  buildExcelPreview();

  document.getElementById('preview_modal').style.display = 'flex';
  showModalTab('queue');
}

function closePreviewModal(){
  document.getElementById('preview_modal').style.display = 'none';
}

function showModalTab(tab){
  document.getElementById('preview_queue').style.display = tab === 'queue' ? '' : 'none';
  document.getElementById('preview_excel').style.display = tab === 'excel' ? '' : 'none';

  Array.from(document.querySelectorAll('.tab-btn')).forEach(function(btn){
    btn.classList.remove('active');
  });

  if(tab === 'queue'){
    document.querySelectorAll('.tab-btn')[0].classList.add('active');
  } else {
    document.querySelectorAll('.tab-btn')[1].classList.add('active');
  }
}

function buildQueuePreview(){
  var selectedCards = Array.from(document.querySelectorAll('.po-check:checked')).map(function(cb){
    return cb.closest('.po-card');
  });

  var byVendor = {};

  selectedCards.forEach(function(card){
    var vendorGroup = card.closest('.vendor-group');
    var vendor = vendorGroup.querySelector('.vendor-title')?.textContent || '';
    var email = vendorGroup.querySelector('.vendor-meta')?.textContent || '';
    var po = card.querySelector('.po-no')?.textContent || '';
    var lineCount = card.querySelectorAll('tbody tr').length;
    var key = vendor + '|' + email;

    if(!byVendor[key]){
      byVendor[key] = {vendor:vendor, email:email, pos:[], lines:0};
    }

    byVendor[key].pos.push(po);
    byVendor[key].lines += lineCount;
  });

  var html = '<h3>Email Queue Preview</h3>';
  Object.keys(byVendor).forEach(function(k){
    var v = byVendor[k];
    html += '<div class="preview-row">' +
      '<div class="preview-vendor">' + escapeHtml(v.vendor) + '</div>' +
      '<div class="preview-meta">Recipient: ' + escapeHtml(v.email) +
      '<span class="preview-pill">' + v.pos.length + ' PO(s)</span>' +
      '<span class="preview-pill">' + v.lines + ' line(s)</span></div>' +
      '<div class="preview-meta">POs: ' + escapeHtml(v.pos.join(', ')) + '</div>' +
      '</div>';
  });

  document.getElementById('preview_queue').innerHTML = html;
}

function buildExcelPreview(){
  var selectedCards = Array.from(document.querySelectorAll('.po-check:checked')).map(function(cb){
    return cb.closest('.po-card');
  });

  var byVendor = {};

  selectedCards.forEach(function(card){
    var vendorGroup = card.closest('.vendor-group');
    var vendor = vendorGroup.querySelector('.vendor-title')?.textContent || '';
    var email = vendorGroup.querySelector('.vendor-meta')?.textContent || '';
    var key = vendor + '|' + email;
    var po = card.querySelector('.po-no')?.textContent || '';

    if(!byVendor[key]){
      byVendor[key] = {vendor:vendor, email:email, rows:[]};
    }

    card.querySelectorAll('tbody tr').forEach(function(tr){
      var cells = Array.from(tr.querySelectorAll('td')).map(function(td){
        return td.textContent.trim();
      });

      byVendor[key].rows.push([po].concat(cells));
    });
  });

  var html = '<h3>Expandable Excel Preview</h3>';

  Object.keys(byVendor).forEach(function(k, idx){
    var v = byVendor[k];

    html += '<div class="excel-preview-group">' +
      '<div class="excel-preview-head" onclick="toggleExcelPreviewGroup(' + idx + ')">' +
      escapeHtml(v.vendor) + ' · ' + v.rows.length + ' Excel row(s)' +
      '</div>' +
      '<div class="excel-preview-body" id="excel_group_' + idx + '">' +
      '<table class="excel-table">' +
      '<thead><tr><th>PO</th><th>Item</th><th>Memo</th><th>Qty</th><th>Received</th><th>Open Qty</th><th>Expected Receipt</th><th>Amount</th></tr></thead><tbody>';

    v.rows.forEach(function(r){
      html += '<tr>' + r.map(function(c){
        return '<td>' + escapeHtml(c) + '</td>';
      }).join('') + '</tr>';
    });

    html += '</tbody></table></div></div>';
  });

  document.getElementById('preview_excel').innerHTML = html;
}

function toggleExcelPreviewGroup(idx){
  var el = document.getElementById('excel_group_' + idx);
  if(el) el.style.display = el.style.display === 'block' ? 'none' : 'block';
}

function submitSelected(){
  syncFilters();

  var ids = getSelectedIds();

  if(!ids.length){
    alert('Please select at least one PO.');
    return;
  }

  document.getElementById('custpage_selected_po_ids').value = ids.join(',');
  document.getElementById('custpage_action').value = 'send';
  document.forms[0].submit();
}

function exportVisibleCsv(){
  var rows = collectVisibleRows();
  downloadText('open_po_followup.csv', toCsv(rows), 'text/csv');
}

function exportVisibleXls(){
  var rows = collectVisibleRows();
  var html = '<html><body><table border="1">' + rows.map(function(r){
    return '<tr>' + r.map(function(c){ return '<td>' + escapeHtml(c) + '</td>'; }).join('') + '</tr>';
  }).join('') + '</table></body></html>';
  downloadText('open_po_followup.xls', html, 'application/vnd.ms-excel');
}

function collectVisibleRows(){
  var rows = [['Vendor','PO Number','Item','Memo','Qty','Received','Open Qty','Expected Receipt','Amount']];
  document.querySelectorAll('.vendor-group').forEach(function(group){
    if(group.style.display === 'none') return;
    var vendor = group.querySelector('.vendor-title')?.textContent || '';
    group.querySelectorAll('.po-card').forEach(function(card){
      var po = card.querySelector('.po-no')?.textContent || '';
      card.querySelectorAll('tbody tr').forEach(function(tr){
        var cells = Array.from(tr.querySelectorAll('td')).map(function(td){ return td.textContent.trim(); });
        rows.push([vendor, po].concat(cells));
      });
    });
  });
  return rows;
}

function toCsv(rows){
  return rows.map(function(row){
    return row.map(function(cell){
      return '"' + String(cell || '').replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\\n');
}

function downloadText(filename, text, mime){
  var blob = new Blob([text], {type:mime});
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

document.addEventListener('DOMContentLoaded', initWorkbench);
</script>`;
  }

  function sendEmails(context) {
    const ids = String(context.request.parameters.custpage_selected_po_ids || '').split(',').filter(Boolean);
    const script = runtime.getCurrentScript();

    const testMode =
      script.getParameter({ name: PARAM_TEST_MODE }) === true ||
      script.getParameter({ name: PARAM_TEST_MODE }) === 'T';

    const testAuthorEmployeeId = script.getParameter({ name: PARAM_TEST_SEND_EMPLOYEE });
    const testRecipientEmployeeId = script.getParameter({ name: PARAM_TEST_RECIPIENT_EMPLOYEE });
    const testRecipientEmail = testRecipientEmployeeId ? getEmployeeEmail(testRecipientEmployeeId) : '';

    if (testMode && !testRecipientEmail) {
      context.request.parameters.custpage_success_msg = 'Test Mode Error: recipient employee parameter is missing or employee has no email.';
      render(context);
      return;
    }

    const rows = getPoLines({ poIds: ids, fromDate: null, toDate: null, poNumber: null });
    const grouped = groupByVendor(rows);

    const author = testMode && testAuthorEmployeeId ? Number(testAuthorEmployeeId) : runtime.getCurrentUser().id;

    let sent = 0;
    let skipped = 0;

    grouped.forEach(v => {
      const recipients = testMode ? testRecipientEmail : v.vendorEmail;

      if (!recipients) {
        skipped++;
        return;
      }

      email.send({
        author,
        recipients,
        subject: `${testMode ? '[TEST MODE] ' : ''}Open Purchase Order Follow-up - ${v.vendorName}`,
        body: buildEmailBody(v, testMode, recipients),
        attachments: [createVendorXlsAttachment(v)],
        relatedRecords: v.vendorId ? { entityId: Number(v.vendorId) } : undefined
      });

      sent++;
    });

    context.request.parameters.custpage_success_msg =
      sent + ' email(s) sent successfully. Skipped: ' + skipped + '. Test Mode: ' + (testMode ? 'Enabled' : 'Disabled');

    render(context);
  }

  function createVendorXlsAttachment(vendor) {
    let html = `
<html><head><meta charset="UTF-8"></head><body>
<h2>Open Purchase Order Follow-up</h2>
<table border="1">
<tr><td><b>Vendor</b></td><td>${esc(vendor.vendorName)}</td></tr>
<tr><td><b>Vendor Email</b></td><td>${esc(vendor.vendorEmail || '')}</td></tr>
</table>
<br>
<table border="1">
<tr>
<th>PO Number</th><th>PO Date</th><th>Item</th><th>Memo</th><th>Qty</th><th>Received</th><th>Open Qty</th><th>Expected Receipt</th><th>Amount</th>
</tr>`;

    vendor.pos.forEach(po => {
      po.lines.forEach(l => {
        html += `
<tr>
<td>${esc(po.poNumber)}</td>
<td>${esc(po.poDate)}</td>
<td>${esc(l.item)}</td>
<td>${esc(l.memo)}</td>
<td>${l.qty}</td>
<td>${l.received}</td>
<td>${l.openQty}</td>
<td>${esc(l.expectedDate || '')}</td>
<td>${formatNumber(l.amount)}</td>
</tr>`;
      });
    });

    html += `</table></body></html>`;

    return file.create({
      name: sanitizeFileName(`Open_PO_Followup_${vendor.vendorName}.xls`),
      fileType: file.Type.HTMLDOC,
      contents: html
    });
  }

  function buildEmailBody(vendor, testMode, actualRecipient) {
    let html = '';

    if (testMode) {
      html += `
<div style="border:1px solid #f59e0b;background:#fffbeb;padding:10px;margin-bottom:15px;">
<b>TEST MODE ENABLED</b><br>
Original Vendor: ${esc(vendor.vendorName)}<br>
Original Vendor Email: ${esc(vendor.vendorEmail || 'Missing')}<br>
Actual Recipient: ${esc(actualRecipient)}
</div>`;
    }

    html += `
<p>Hello ${esc(vendor.vendorName)},</p>
<p>Please provide an update for the open purchase order line(s) in the attached Excel file.</p>
<p>Thank you,<br>Purchasing Team</p>`;

    return html;
  }

  function getEmployeeEmail(employeeId) {
    try {
      const data = search.lookupFields({
        type: search.Type.EMPLOYEE,
        id: employeeId,
        columns: ['email']
      });
      return data && data.email ? data.email : '';
    } catch (e) {
      return '';
    }
  }

  function cleanPoNumber(value) {
    return String(value || '').trim().toUpperCase();
  }

  function parseNsDate(value) {
    try {
      return stripTime(format.parse({ value, type: format.Type.DATE }));
    } catch (e) {
      const d = new Date(value);
      return stripTime(d);
    }
  }

  function stripTime(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function fmtDate(d) {
    return format.format({ value: d, type: format.Type.DATE });
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function sanitizeFileName(name) {
    return String(name || 'Open_PO_Followup.xls')
      .replace(/[\\\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_');
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escAttr(v) {
    return esc(v).replace(/`/g, '&#096;');
  }

  return { onRequest };
});