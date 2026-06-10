/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Developer: Ramakrishna Ambati
 * Date: 2026-06-09
 * Version: 2026.06.09.1
 * Description: Location standard cost lookup for inventory and assembly items.
 */
define(['N/ui/serverWidget', 'N/search', 'N/runtime', 'N/url', 'N/record'], (
  serverWidget,
  search,
  runtime,
  url,
  record
) => {
  const PAGE_SIZE = 1000;
  const MAX_RESULTS = 1000;
  const DEVELOPER_NAME = 'Ramakrishna Ambati';
  const SCRIPT_DATE = '2026-06-09';
  const SCRIPT_VERSION = '2026.06.09.1';

  const PARAMS = {
    po: 'custpage_po',
    item: 'custpage_item',
    itemText: 'custpage_item_text',
    location: 'custpage_location',
    itemType: 'custpage_item_type',
    includeInactive: 'custpage_include_inactive'
  };

  function onRequest(context) {
    const request = context.request;
    const response = context.response;

    if (request.method === 'POST') {
      redirectToGet(request, response);
      return;
    }

    const filters = normalizeFilters(request.parameters);
    const form = buildForm(filters);
    const isPoMode = Boolean(filters.poText);
    const hasCriteria = Boolean(isPoMode || filters.itemId || filters.itemText || filters.locationId);

    let rows = [];
    let totalCount = 0;
    let poInfo = null;
    let errorMessage = '';

    if (isPoMode) {
      try {
        const result = getPoLineStandardCostRows(filters);
        rows = result.rows;
        totalCount = result.totalCount;
        poInfo = result.poInfo;
      } catch (e) {
        errorMessage = e.name + ': ' + e.message;
      }
    } else if (hasCriteria) {
      try {
        const result = getLocationStandardCostRows(filters);
        rows = result.rows;
        totalCount = result.totalCount;
      } catch (e) {
        errorMessage = e.name + ': ' + e.message;
      }
    }

    addMessage(form, {
      hasCriteria,
      isPoMode,
      poInfo,
      errorMessage,
      shownCount: rows.length,
      totalCount,
      missingCount: isPoMode ? rows.filter(isMissingPoLineCost).length : 0
    });

    if (isPoMode) {
      addPoResultsHtml(form, rows, poInfo, totalCount);
    } else {
      addResultsSublist(form, rows);
    }

    response.writePage(form);
  }

  function buildForm(filters) {
    const form = serverWidget.createForm({
      title: 'Location Standard Cost Lookup'
    });

    const filterGroup = form.addFieldGroup({
      id: 'custpage_filters_group',
      label: 'Filters'
    });
    filterGroup.isCollapsible = true;
    filterGroup.isCollapsed = Boolean(filters.poText || filters.itemId || filters.itemText || filters.locationId);

    const poFld = form.addField({
      id: PARAMS.po,
      type: serverWidget.FieldType.TEXT,
      label: 'PO Number / Internal ID',
      container: 'custpage_filters_group'
    });
    poFld.defaultValue = filters.poText;

    const itemFld = form.addField({
      id: PARAMS.item,
      type: serverWidget.FieldType.SELECT,
      label: 'Item',
      source: 'item',
      container: 'custpage_filters_group'
    });
    itemFld.defaultValue = filters.itemId;

    const itemTextFld = form.addField({
      id: PARAMS.itemText,
      type: serverWidget.FieldType.TEXT,
      label: 'Item Name / Number Contains',
      container: 'custpage_filters_group'
    });
    itemTextFld.defaultValue = filters.itemText;

    const locationFld = form.addField({
      id: PARAMS.location,
      type: serverWidget.FieldType.SELECT,
      label: 'Location',
      source: 'location',
      container: 'custpage_filters_group'
    });
    locationFld.defaultValue = filters.locationId;

    const typeFld = form.addField({
      id: PARAMS.itemType,
      type: serverWidget.FieldType.SELECT,
      label: 'Item Type',
      container: 'custpage_filters_group'
    });
    typeFld.addSelectOption({ value: '', text: '- Inventory and Assembly -' });
    typeFld.addSelectOption({ value: 'InvtPart', text: 'Inventory Item' });
    typeFld.addSelectOption({ value: 'Assembly', text: 'Assembly Item' });
    typeFld.defaultValue = filters.itemType;

    const inactiveFld = form.addField({
      id: PARAMS.includeInactive,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Include Inactive Items',
      container: 'custpage_filters_group'
    });
    inactiveFld.defaultValue = filters.includeInactive ? 'T' : 'F';

    form.addSubmitButton({ label: 'Search Standard Cost' });

    return form;
  }

  function addMessage(form, opts) {
    let html;

    if (opts.errorMessage) {
      html = '<div style="margin:12px 0;color:#b00020;font-weight:700;">' +
        escapeHtml(opts.errorMessage) +
        '</div>';
    } else if (opts.isPoMode && opts.poInfo) {
      html = buildPoSummaryHtml(opts);
    } else if (!opts.hasCriteria) {
      html = '<div style="margin:12px 0;">Enter a PO number/internal ID to check PO line standard costs, or select an item, location, or item text to search location standard costs.</div>';
    } else {
      const capped = opts.totalCount > opts.shownCount;
      html = '<div style="margin:12px 0;">' +
        '<b>Rows shown:</b> ' + escapeHtml(opts.shownCount) +
        ' <span style="color:#666;">of ' + escapeHtml(opts.totalCount) + '</span>' +
        (capped ? ' <span style="color:#b26a00;">Showing first ' + MAX_RESULTS + ' rows.</span>' : '') +
        '</div>';
    }

    const fld = form.addField({
      id: 'custpage_message',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Status'
    });
    fld.defaultValue = html;
  }

  function buildPoSummaryHtml(opts) {
    const locationText = opts.poInfo.headerLocationText || 'Blank';
    const missingCount = Number(opts.missingCount || 0);
    let html = '' +
      '<style>' +
      '.pq-summary-grid{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:14px 0;max-width:1100px;}' +
      '.pq-summary-card{border:1px solid #d9d9d9;background:#fff;border-radius:4px;padding:10px 12px;min-height:58px;}' +
      '.pq-summary-card .pq-label{font-size:11px;text-transform:uppercase;color:#666;margin-bottom:5px;}' +
      '.pq-summary-card .pq-value{font-size:18px;font-weight:700;color:#222;line-height:1.2;}' +
      '.pq-summary-card .pq-sub{font-size:11px;color:#777;margin-top:4px;}' +
      '.pq-summary-card.pq-alert{border-color:#f1b5b5;background:#fff7f7;}' +
      '.pq-summary-card.pq-ok{border-color:#b7d8bd;background:#f3fbf4;}' +
      '.pq-success{max-width:1100px;margin:8px 0 14px;padding:10px 12px;border-left:5px solid #2e7d32;background:#eef8ef;color:#174f1f;font-weight:700;}' +
      '.pq-warning{max-width:1100px;margin:8px 0 14px;padding:10px 12px;border-left:5px solid #b26a00;background:#fff8e6;color:#6f4400;font-weight:700;}' +
      '@media(max-width:900px){.pq-summary-grid{grid-template-columns:repeat(2,minmax(150px,1fr));}}' +
      '</style>' +
      '<div class="pq-summary-grid">' +
      summaryCard('PO Lines Checked', opts.totalCount, 'Rows shown: ' + opts.shownCount, '') +
      summaryCard('Missing Std Cost', missingCount, missingCount ? 'Action needed' : 'Clear', missingCount ? 'pq-alert' : 'pq-ok') +
      summaryCard('Header Location', locationText, opts.poInfo.headerLocationId ? 'ID ' + opts.poInfo.headerLocationId : '', opts.poInfo.headerLocationId ? '' : 'pq-alert') +
      summaryCard('Vendor', opts.poInfo.vendor, opts.poInfo.tranId + ' | ' + opts.poInfo.tranDate, '') +
      '</div>';

    if (!missingCount && opts.poInfo.headerLocationId) {
      html += '<div class="pq-success">All inventory/assembly PO lines have standard cost for ' + escapeHtml(locationText) + '.</div>';
    }

    if (!opts.poInfo.headerLocationId) {
      html += '<div class="pq-warning">PO header location is blank; location standard cost cannot be matched.</div>';
    }

    return html;
  }

  function summaryCard(label, value, subText, extraClass) {
    return '<div class="pq-summary-card ' + escapeHtml(extraClass || '') + '">' +
      '<div class="pq-label">' + escapeHtml(label) + '</div>' +
      '<div class="pq-value">' + escapeHtml(value) + '</div>' +
      (subText ? '<div class="pq-sub">' + escapeHtml(subText) + '</div>' : '') +
      '</div>';
  }

  function addResultsSublist(form, rows) {
    const sublist = form.addSublist({
      id: 'custpage_results',
      type: serverWidget.SublistType.LIST,
      label: 'Inventory / Assembly Location Standard Costs'
    });

    sublist.addField({ id: 'item_internal_id', type: serverWidget.FieldType.TEXT, label: 'Item Internal ID' });
    sublist.addField({ id: 'itemid', type: serverWidget.FieldType.TEXT, label: 'Item Name/Number' });
    sublist.addField({ id: 'displayname', type: serverWidget.FieldType.TEXT, label: 'Display Name' });
    sublist.addField({ id: 'itemtype', type: serverWidget.FieldType.TEXT, label: 'Item Type' });
    sublist.addField({ id: 'costingmethod', type: serverWidget.FieldType.TEXT, label: 'Costing Method' });
    sublist.addField({ id: 'location', type: serverWidget.FieldType.TEXT, label: 'Location' });
    sublist.addField({ id: 'standardcost', type: serverWidget.FieldType.CURRENCY, label: 'Standard Cost' });
    sublist.addField({ id: 'qtyonhand', type: serverWidget.FieldType.FLOAT, label: 'Qty On Hand' });
    sublist.addField({ id: 'qtyavailable', type: serverWidget.FieldType.FLOAT, label: 'Qty Available' });
    sublist.addField({ id: 'isinactive', type: serverWidget.FieldType.TEXT, label: 'Inactive' });

    rows.forEach((row, line) => {
      setSublistValue(sublist, 'item_internal_id', line, row.itemInternalId);
      setSublistValue(sublist, 'itemid', line, row.itemId);
      setSublistValue(sublist, 'displayname', line, row.displayName);
      setSublistValue(sublist, 'itemtype', line, row.itemType);
      setSublistValue(sublist, 'costingmethod', line, row.costingMethod);
      setSublistValue(sublist, 'location', line, row.location);
      setSublistValue(sublist, 'standardcost', line, row.standardCost);
      setSublistValue(sublist, 'qtyonhand', line, row.qtyOnHand);
      setSublistValue(sublist, 'qtyavailable', line, row.qtyAvailable);
      setSublistValue(sublist, 'isinactive', line, row.isInactive);
    });
  }

  function addPoResultsSublist(form, rows) {
    const sublist = form.addSublist({
      id: 'custpage_po_results',
      type: serverWidget.SublistType.LIST,
      label: 'PO Lines - Standard Cost at Header Location'
    });

    sublist.addField({ id: 'line_no', type: serverWidget.FieldType.TEXT, label: 'PO Line' });
    sublist.addField({ id: 'po_number', type: serverWidget.FieldType.TEXT, label: 'PO Number' });
    sublist.addField({ id: 'vendor', type: serverWidget.FieldType.TEXT, label: 'Vendor' });
    sublist.addField({ id: 'headerlocation', type: serverWidget.FieldType.TEXT, label: 'Header Location' });
    sublist.addField({ id: 'item_internal_id', type: serverWidget.FieldType.TEXT, label: 'Item Internal ID' });
    sublist.addField({ id: 'itemid', type: serverWidget.FieldType.TEXT, label: 'Item Name/Number' });
    sublist.addField({ id: 'description', type: serverWidget.FieldType.TEXT, label: 'Line Description' });
    sublist.addField({ id: 'itemtype', type: serverWidget.FieldType.TEXT, label: 'Item Type' });
    sublist.addField({ id: 'costingmethod', type: serverWidget.FieldType.TEXT, label: 'Costing Method' });
    sublist.addField({ id: 'quantity', type: serverWidget.FieldType.FLOAT, label: 'PO Qty' });
    sublist.addField({ id: 'rate', type: serverWidget.FieldType.CURRENCY, label: 'PO Rate' });
    sublist.addField({ id: 'amount', type: serverWidget.FieldType.CURRENCY, label: 'PO Amount' });
    sublist.addField({ id: 'standardcost', type: serverWidget.FieldType.CURRENCY, label: 'Std Cost @ Header Loc' });
    sublist.addField({ id: 'qtyonhand', type: serverWidget.FieldType.FLOAT, label: 'Qty On Hand' });
    sublist.addField({ id: 'qtyavailable', type: serverWidget.FieldType.FLOAT, label: 'Qty Available' });
    sublist.addField({ id: 'coststatus', type: serverWidget.FieldType.TEXT, label: 'Status' });

    rows.forEach((row, line) => {
      setSublistValue(sublist, 'line_no', line, row.lineNo);
      setSublistValue(sublist, 'po_number', line, row.poNumber);
      setSublistValue(sublist, 'vendor', line, row.vendor);
      setSublistValue(sublist, 'headerlocation', line, row.headerLocation);
      setSublistValue(sublist, 'item_internal_id', line, row.itemInternalId);
      setSublistValue(sublist, 'itemid', line, row.itemId);
      setSublistValue(sublist, 'description', line, row.description);
      setSublistValue(sublist, 'itemtype', line, row.itemType);
      setSublistValue(sublist, 'costingmethod', line, row.costingMethod);
      setSublistValue(sublist, 'quantity', line, row.quantity);
      setSublistValue(sublist, 'rate', line, row.rate);
      setSublistValue(sublist, 'amount', line, row.amount);
      setSublistValue(sublist, 'standardcost', line, row.standardCost);
      setSublistValue(sublist, 'qtyonhand', line, row.qtyOnHand);
      setSublistValue(sublist, 'qtyavailable', line, row.qtyAvailable);
      setSublistValue(sublist, 'coststatus', line, row.costStatus);
    });
  }

  function addPoResultsHtml(form, rows, poInfo, totalCount) {
    const fld = form.addField({
      id: 'custpage_po_results_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'PO Lines'
    });

    try {
      fld.updateLayoutType({ layoutType: serverWidget.FieldLayoutType.OUTSIDEBELOW });
      fld.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });
    } catch (e) {
      // Older NetSuite form layouts can ignore these hints safely.
    }

    fld.defaultValue = buildPoResultsHtml(rows, poInfo, totalCount);
  }

  function buildPoResultsHtml(rows, poInfo, totalCount) {
    const missingCount = rows.filter(isMissingPoLineCost).length;
    let html = '' +
      '<style>' +
      '.pq-cost-wrap{margin-top:18px;border:1px solid #d8d8d8;background:#fff;overflow:auto;max-width:100%;}' +
      '.pq-cost-title{background:#ecd6d8;color:#7a0808;font-weight:700;padding:8px 10px;font-size:14px;border-bottom:1px solid #d8d8d8;}' +
      '.pq-cost-summary{padding:8px 10px;border-bottom:1px solid #e0e0e0;background:#fafafa;color:#333;}' +
      '.pq-cost-summary strong{color:#b00020;}' +
      '.pq-cost-table{border-collapse:collapse;width:100%;min-width:1400px;font-size:12px;line-height:1.35;}' +
      '.pq-cost-table th{background:#e6e6e6;color:#555;text-transform:uppercase;font-weight:400;text-align:left;border-bottom:1px solid #d2d2d2;padding:7px 8px;white-space:nowrap;}' +
      '.pq-cost-table td{border-bottom:1px solid #e5e5e5;padding:8px;vertical-align:top;color:#222;background:#fff;}' +
      '.pq-cost-table .pq-num{text-align:right;white-space:nowrap;}' +
      '.pq-cost-table .pq-small{white-space:nowrap;}' +
      '.pq-row-missing td{background:#fff1f1;}' +
      '.pq-row-missing td:first-child{box-shadow:inset 4px 0 0 #c62828;font-weight:700;color:#7a0808;}' +
      '.pq-missing-cell{color:#b00020;font-weight:700;background:#ffe4e4!important;}' +
      '.pq-action-link{display:inline-block;margin-right:6px;color:#25589a;font-weight:700;text-decoration:none;white-space:nowrap;}' +
      '.pq-status{display:inline-block;border-radius:10px;padding:2px 8px;font-weight:700;white-space:nowrap;}' +
      '.pq-status-ok{background:#e8f5e9;color:#1b5e20;}' +
      '.pq-status-missing{background:#ffcdd2;color:#8b0000;}' +
      '.pq-status-muted{background:#eeeeee;color:#555;}' +
      '.pq-empty{padding:16px;color:#555;}' +
      '.pq-empty-ok{background:#eef8ef;color:#174f1f;font-weight:700;}' +
      '</style>' +
      '<div class="pq-cost-wrap">' +
      '<div class="pq-cost-title">PO Lines Missing Standard Cost at Header Location</div>';

    if (!rows.length) {
      const locationText = poInfo && poInfo.headerLocationText ? poInfo.headerLocationText : 'the PO header location';
      return html + '<div class="pq-empty pq-empty-ok">All inventory/assembly PO lines have standard cost for ' + escapeHtml(locationText) + '.</div></div>';
    }

    html += '<div class="pq-cost-summary">';
    if (missingCount) {
      html += '<strong>' + escapeHtml(missingCount) + '</strong> line' + (missingCount === 1 ? '' : 's') + ' missing standard cost are shown.';
    } else {
      html += 'No missing standard cost lines found.';
    }
    html += '</div>';

    html += '<table class="pq-cost-table">' +
      '<thead><tr>' +
      '<th>PO Line</th>' +
      '<th>Item Internal ID</th>' +
      '<th>Item Name/Number</th>' +
      '<th>Line Description</th>' +
      '<th>Item Type</th>' +
      '<th>Costing Method</th>' +
      '<th class="pq-num">PO Qty</th>' +
      '<th class="pq-num">PO Rate</th>' +
      '<th class="pq-num">PO Amount</th>' +
      '<th class="pq-num">Std Cost @ Header Loc</th>' +
      '<th class="pq-num">Qty On Hand</th>' +
      '<th class="pq-num">Qty Available</th>' +
      '<th>Open Item</th>' +
      '<th>Open PO</th>' +
      '<th>Suggested Action</th>' +
      '<th>Status</th>' +
      '</tr></thead><tbody>';

    rows.forEach((row) => {
      const missing = isMissingPoLineCost(row);
      html += '<tr class="' + (missing ? 'pq-row-missing' : '') + '">' +
        htmlCell(row.lineNo, 'pq-small') +
        htmlCell(row.itemInternalId, 'pq-small') +
        htmlCell(row.itemId, 'pq-small') +
        htmlCell(row.description, '') +
        htmlCell(row.itemType, 'pq-small') +
        htmlCell(row.costingMethod, 'pq-small') +
        htmlCell(row.quantity, 'pq-num') +
        htmlCell(row.rate, 'pq-num') +
        htmlCell(row.amount, 'pq-num') +
        htmlStandardCostCell(row) +
        htmlCell(row.qtyOnHand, 'pq-num') +
        htmlCell(row.qtyAvailable, 'pq-num') +
        htmlLinkCell(row.itemUrl, 'Open Item') +
        htmlLinkCell(row.poUrl, 'Open PO') +
        htmlCell(row.suggestedAction, '') +
        '<td>' + htmlStatus(row) + '</td>' +
        '</tr>';
    });

    html += '</tbody></table></div>';
    return html;
  }

  function htmlCell(value, className) {
    return '<td' + (className ? ' class="' + className + '"' : '') + '>' + escapeHtml(value) + '</td>';
  }

  function htmlLinkCell(href, label) {
    if (!href) {
      return '<td></td>';
    }

    return '<td><a class="pq-action-link" href="' + escapeAttr(href) + '" target="_blank">' + escapeHtml(label) + '</a></td>';
  }

  function htmlStandardCostCell(row) {
    if (isMissingPoLineCost(row)) {
      return '<td class="pq-num pq-missing-cell">' + escapeHtml(row.standardCost === '' ? 'Missing' : row.standardCost) + '</td>';
    }

    return htmlCell(row.standardCost, 'pq-num');
  }

  function htmlStatus(row) {
    const status = row.costStatus || '';
    let cls = 'pq-status-muted';

    if (status === 'OK') {
      cls = 'pq-status-ok';
    } else if (isMissingPoLineCost(row)) {
      cls = 'pq-status-missing';
    }

    return '<span class="pq-status ' + cls + '">' + escapeHtml(status) + '</span>';
  }

  function getPoLineStandardCostRows(filters) {
    const po = findPurchaseOrder(filters.poText);
    const poRec = record.load({
      type: record.Type.PURCHASE_ORDER,
      id: po.id,
      isDynamic: false
    });

    const poInfo = {
      id: String(po.id),
      tranId: safeGetValue(poRec, 'tranid') || po.tranId || String(po.id),
      vendor: safeGetText(poRec, 'entity') || safeGetValue(poRec, 'entity'),
      tranDate: safeGetValue(poRec, 'trandate'),
      headerLocationId: safeGetValue(poRec, 'location'),
      headerLocationText: safeGetText(poRec, 'location')
    };

    let lines = getPurchaseOrderItemLines(poRec);
    lines = filterPoLines(lines, filters);

    const itemIds = unique(lines.map((line) => line.itemInternalId).filter(Boolean));
    const itemInfoMap = getItemInfoMap(itemIds);
    const costEligibleLines = lines.filter((line) => {
      const itemInfo = itemInfoMap[line.itemInternalId] || {};

      if (!isInventoryOrAssembly(itemInfo)) {
        return false;
      }

      if (filters.itemType) {
        return itemInfo.itemTypeValue === filters.itemType;
      }

      return true;
    });
    const costEligibleItemIds = unique(costEligibleLines.map((line) => line.itemInternalId).filter(Boolean));
    const costMap = poInfo.headerLocationId ? getLocationCostMap(costEligibleItemIds, poInfo.headerLocationId, itemInfoMap) : {};
    const poUrl = buildRecordUrl(record.Type.PURCHASE_ORDER, poInfo.id);

    const allRows = costEligibleLines.map((line) => {
      const itemInfo = itemInfoMap[line.itemInternalId] || {};
      const cost = costMap[line.itemInternalId] || {};
      const hasCostRow = Boolean(cost.itemInternalId);
      const costStatus = getPoLineCostStatus({
        poInfo,
        itemInfo,
        hasCostRow,
        standardCost: cost.standardCost
      });

      return {
        lineNo: line.lineNo,
        poNumber: poInfo.tranId,
        vendor: poInfo.vendor,
        headerLocation: poInfo.headerLocationText || poInfo.headerLocationId,
        itemInternalId: line.itemInternalId,
        itemId: cost.itemId || itemInfo.itemId || line.itemText,
        description: line.description,
        itemType: cost.itemType || itemInfo.itemType || '',
        costingMethod: cost.costingMethod || itemInfo.costingMethod || '',
        quantity: line.quantity,
        rate: line.rate,
        amount: line.amount,
        standardCost: valueOrBlank(cost.standardCost),
        qtyOnHand: cost.qtyOnHand || '',
        qtyAvailable: cost.qtyAvailable || '',
        itemUrl: buildItemUrl(itemInfo, line.itemInternalId),
        poUrl,
        suggestedAction: getSuggestedAction({
          itemId: cost.itemId || itemInfo.itemId || line.itemText,
          headerLocation: poInfo.headerLocationText || poInfo.headerLocationId,
          costStatus
        }),
        costStatus
      };
    });

    const rows = allRows.filter(isMissingPoLineCost);

    return {
      rows,
      totalCount: costEligibleLines.length,
      poInfo
    };
  }

  function findPurchaseOrder(poText) {
    const text = clean(poText);
    let po = null;

    if (!text) {
      throw new Error('Enter a PO number or internal ID.');
    }

    if (/^\d+$/.test(text)) {
      po = searchPurchaseOrder(['internalid', 'anyof', text]);
    }

    po = po || searchPurchaseOrder(['tranid', 'is', text]);
    po = po || searchPurchaseOrder(['tranid', 'contains', text]);

    if (!po) {
      throw new Error('Purchase Order not found for "' + text + '".');
    }

    return po;
  }

  function searchPurchaseOrder(matchFilter) {
    const poSearch = search.create({
      type: search.Type.PURCHASE_ORDER,
      filters: [
        ['mainline', 'is', 'T'],
        'AND',
        matchFilter
      ],
      columns: [
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        'internalid',
        'tranid'
      ]
    });

    const results = poSearch.run().getRange({ start: 0, end: 1 }) || [];
    if (!results.length) {
      return null;
    }

    return {
      id: results[0].getValue({ name: 'internalid' }),
      tranId: results[0].getValue({ name: 'tranid' })
    };
  }

  function getPurchaseOrderItemLines(poRec) {
    const lineCount = poRec.getLineCount({ sublistId: 'item' }) || 0;
    const lines = [];

    for (let i = 0; i < lineCount; i += 1) {
      const itemId = safeGetSublistValue(poRec, 'item', 'item', i);

      if (!itemId) {
        continue;
      }

      lines.push({
        lineNo: String(i + 1),
        itemInternalId: itemId,
        itemText: safeGetSublistText(poRec, 'item', 'item', i),
        description: safeGetSublistValue(poRec, 'item', 'description', i),
        quantity: formatNumber(safeGetSublistValue(poRec, 'item', 'quantity', i)),
        rate: formatNumber(safeGetSublistValue(poRec, 'item', 'rate', i)),
        amount: formatNumber(safeGetSublistValue(poRec, 'item', 'amount', i))
      });
    }

    return lines;
  }

  function filterPoLines(lines, filters) {
    const itemText = (filters.itemText || '').toLowerCase();

    return lines.filter((line) => {
      if (filters.itemId && line.itemInternalId !== filters.itemId) {
        return false;
      }

      if (itemText) {
        const haystack = [
          line.itemInternalId,
          line.itemText,
          line.description
        ].join(' ').toLowerCase();

        if (haystack.indexOf(itemText) === -1) {
          return false;
        }
      }

      return true;
    });
  }

  function getItemInfoMap(itemIds) {
    const out = {};

    chunk(itemIds, 900).forEach((ids) => {
      const itemSearch = search.create({
        type: search.Type.ITEM,
        filters: [['internalid', 'anyof', ids]],
        columns: [
          'internalid',
          'itemid',
          'displayname',
          'type',
          'costingmethod'
        ]
      });

      itemSearch.run().each((r) => {
        const id = String(r.getValue({ name: 'internalid' }) || '');

        if (id) {
          out[id] = {
            itemInternalId: id,
            itemId: r.getValue({ name: 'itemid' }) || '',
            displayName: r.getValue({ name: 'displayname' }) || '',
            itemTypeValue: r.getValue({ name: 'type' }) || '',
            itemType: r.getText({ name: 'type' }) || r.getValue({ name: 'type' }) || '',
            costingMethod: r.getText({ name: 'costingmethod' }) || r.getValue({ name: 'costingmethod' }) || ''
          };
        }

        return true;
      });
    });

    return out;
  }

  function getLocationCostMap(itemIds, locationId, itemInfoMap) {
    const out = {};

    chunk(itemIds, 900).forEach((ids) => {
      const revalSearch = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'InvReval'],
          'AND',
          ['mainline', 'is', 'F'],
          'AND',
          ['item', 'anyof', ids],
          'AND',
          ['location', 'anyof', locationId]
        ],
        columns: [
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          'internalid',
          'item',
          'location'
        ]
      });

      revalSearch.run().each((r) => {
        const id = String(r.getValue({ name: 'item' }) || '');

        if (id && !out[id]) {
          const itemInfo = itemInfoMap[id] || {};

          out[id] = {
            itemInternalId: id,
            itemId: itemInfo.itemId || r.getText({ name: 'item' }) || '',
            displayName: itemInfo.displayName || '',
            itemTypeValue: itemInfo.itemTypeValue || '',
            itemType: itemInfo.itemType || '',
            costingMethod: itemInfo.costingMethod || '',
            location: r.getText({ name: 'location' }) || r.getValue({ name: 'location' }) || '',
            standardCost: 'ROW FOUND',
            qtyOnHand: '',
            qtyAvailable: ''
          };
        }

        return true;
      });
    });

    return out;
  }

  function getPoLineCostStatus(opts) {
    if (!opts.poInfo.headerLocationId) {
      return 'PO header location blank';
    }

    if (!opts.itemInfo.itemInternalId) {
      return 'Item not found';
    }

    if (!isInventoryOrAssembly(opts.itemInfo)) {
      return 'Not inventory/assembly';
    }

    if (!opts.hasCostRow) {
      return 'No standard cost row at PO header location';
    }

    return 'OK';
  }

  function getSuggestedAction(opts) {
    if (opts.costStatus === 'PO header location blank') {
      return 'Set the PO header location, then rerun this check.';
    }

    if (opts.costStatus === 'Item not found') {
      return 'Review the PO line item setup.';
    }

    return 'Create standard cost for ' + (opts.itemId || 'this item') + ' at ' + (opts.headerLocation || 'the PO header location') + '.';
  }

  function buildItemUrl(itemInfo, itemId) {
    return buildRecordUrl(getItemRecordType(itemInfo), itemId);
  }

  function getItemRecordType(itemInfo) {
    const value = clean(itemInfo.itemTypeValue);
    const text = clean(itemInfo.itemType).toLowerCase();

    if (value === 'InvtPart' || text.indexOf('inventory') !== -1) {
      return record.Type.INVENTORY_ITEM;
    }

    if (value === 'Assembly' || text.indexOf('assembly') !== -1) {
      return record.Type.ASSEMBLY_ITEM;
    }

    return '';
  }

  function buildRecordUrl(recordType, recordId) {
    if (!recordType || !recordId) {
      return '';
    }

    try {
      return url.resolveRecord({
        recordType,
        recordId,
        isEditMode: false
      });
    } catch (e) {
      return '';
    }
  }

  function isMissingPoLineCost(row) {
    return row.costStatus === 'Standard cost blank' ||
      row.costStatus === 'No standard cost row at PO header location' ||
      row.costStatus === 'PO header location blank' ||
      row.costStatus === 'Item not found';
  }

  function getLocationStandardCostRows(filters) {
    const itemFilters = [
      ['type', 'anyof', filters.itemType ? [filters.itemType] : ['InvtPart', 'Assembly']]
    ];

    if (!filters.includeInactive) {
      itemFilters.push('AND', ['isinactive', 'is', 'F']);
    }

    if (filters.itemId) {
      itemFilters.push('AND', ['internalid', 'anyof', filters.itemId]);
    }

    if (filters.locationId) {
      itemFilters.push('AND', ['inventorylocation', 'anyof', filters.locationId]);
    }

    if (filters.itemText) {
      itemFilters.push('AND', [
        ['itemid', 'contains', filters.itemText],
        'OR',
        ['displayname', 'contains', filters.itemText]
      ]);
    }

    const itemSearch = search.create({
      type: search.Type.ITEM,
      filters: itemFilters,
      columns: [
        search.createColumn({ name: 'itemid', sort: search.Sort.ASC }),
        'internalid',
        'displayname',
        'type',
        'costingmethod',
        search.createColumn({ name: 'inventorylocation', sort: search.Sort.ASC }),
        'cost',
        'locationquantityonhand',
        'locationquantityavailable',
        'isinactive'
      ]
    });

    const rows = [];
    const paged = itemSearch.runPaged({ pageSize: PAGE_SIZE });

    for (let i = 0; i < paged.pageRanges.length && rows.length < MAX_RESULTS; i += 1) {
      const page = paged.fetch({ index: paged.pageRanges[i].index });

      for (let j = 0; j < page.data.length && rows.length < MAX_RESULTS; j += 1) {
        const r = page.data[j];

        rows.push({
          itemInternalId: r.getValue({ name: 'internalid' }) || '',
          itemId: r.getValue({ name: 'itemid' }) || '',
          displayName: r.getValue({ name: 'displayname' }) || '',
          itemType: r.getText({ name: 'type' }) || r.getValue({ name: 'type' }) || '',
          costingMethod: r.getText({ name: 'costingmethod' }) || r.getValue({ name: 'costingmethod' }) || '',
          location: r.getText({ name: 'inventorylocation' }) || r.getValue({ name: 'inventorylocation' }) || '',
          standardCost: formatNumber(r.getValue({ name: 'cost' })),
          qtyOnHand: formatNumber(r.getValue({ name: 'locationquantityonhand' })),
          qtyAvailable: formatNumber(r.getValue({ name: 'locationquantityavailable' })),
          isInactive: r.getValue({ name: 'isinactive' }) === true || r.getValue({ name: 'isinactive' }) === 'T' ? 'Yes' : 'No'
        });
      }
    }

    return {
      rows,
      totalCount: paged.count || rows.length
    };
  }

  function normalizeFilters(params) {
    return {
      poText: clean(params[PARAMS.po] || params.po || params.poid || params.tranid || params.recordId || params.recordid),
      itemId: clean(params[PARAMS.item] || params.item || params.itemid),
      itemText: clean(params[PARAMS.itemText] || params.itemtext),
      locationId: clean(params[PARAMS.location] || params.location || params.locationid),
      itemType: normalizeItemType(params[PARAMS.itemType] || params.itemtype),
      includeInactive: params[PARAMS.includeInactive] === 'T' || params.includeinactive === 'T'
    };
  }

  function redirectToGet(request, response) {
    const filters = normalizeFilters(request.parameters);
    const params = {};

    if (filters.poText) params[PARAMS.po] = filters.poText;
    if (filters.itemId) params[PARAMS.item] = filters.itemId;
    if (filters.itemText) params[PARAMS.itemText] = filters.itemText;
    if (filters.locationId) params[PARAMS.location] = filters.locationId;
    if (filters.itemType) params[PARAMS.itemType] = filters.itemType;
    if (filters.includeInactive) params[PARAMS.includeInactive] = 'T';

    const suiteletUrl = url.resolveScript({
      scriptId: runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      params
    });

    response.sendRedirect({
      type: 'EXTERNAL',
      identifier: suiteletUrl
    });
  }

  function normalizeItemType(value) {
    const text = clean(value);
    return text === 'InvtPart' || text === 'Assembly' ? text : '';
  }

  function clean(value) {
    return String(value || '').trim();
  }

  function hasValue(value) {
    return value !== null && value !== undefined && String(value) !== '';
  }

  function valueOrBlank(value) {
    return hasValue(value) ? String(value) : '';
  }

  function unique(values) {
    const seen = {};
    const out = [];

    values.forEach((value) => {
      const text = clean(value);

      if (text && !seen[text]) {
        seen[text] = true;
        out.push(text);
      }
    });

    return out;
  }

  function chunk(values, size) {
    const out = [];

    for (let i = 0; i < values.length; i += size) {
      out.push(values.slice(i, i + size));
    }

    return out;
  }

  function safeGetValue(rec, fieldId) {
    try {
      const value = rec.getValue({ fieldId });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function safeGetText(rec, fieldId) {
    try {
      const value = rec.getText({ fieldId });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function safeGetSublistValue(rec, sublistId, fieldId, line) {
    try {
      const value = rec.getSublistValue({ sublistId, fieldId, line });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function safeGetSublistText(rec, sublistId, fieldId, line) {
    try {
      const value = rec.getSublistText({ sublistId, fieldId, line });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function isInventoryOrAssembly(itemInfo) {
    const value = clean(itemInfo.itemTypeValue);
    const text = clean(itemInfo.itemType).toLowerCase();

    return value === 'InvtPart' ||
      value === 'Assembly' ||
      text.indexOf('inventory') !== -1 ||
      text.indexOf('assembly') !== -1;
  }

  function formatNumber(value) {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    const number = Number(String(value).replace(/,/g, ''));
    if (isNaN(number)) {
      return '';
    }

    return String(number);
  }

  function setSublistValue(sublist, id, line, value) {
    if (value === null || value === undefined || value === '') {
      return;
    }

    sublist.setSublistValue({
      id,
      line,
      value: String(value)
    });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  return { onRequest };
});
