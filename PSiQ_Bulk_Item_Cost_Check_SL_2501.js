/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Developer: Ramakrishna Ambati
 * Date: 2026-06-09
 * Version: 2026.06.09.1
 * Description: Bulk item cost and first inventory transaction checker. Paste
 * comma or newline separated item numbers from an Inventory Adjustment error.
 */
define(['N/ui/serverWidget', 'N/search', 'N/query', 'N/log'], (
  serverWidget,
  search,
  query,
  log
) => {
  const MAX_ITEMS = 1000;
  const NAME_FILTER_CHUNK = 70;
  const ID_CHUNK = 500;

  const PARAMS = {
    items: 'custpage_items',
    location: 'custpage_location',
    includeInactive: 'custpage_include_inactive',
    showOnlyIssues: 'custpage_show_only_issues'
  };

  function onRequest(context) {
    const request = context.request;
    const params = request.parameters || {};
    const filters = normalizeFilters(params);
    const parsed = parseItemNumbers(filters.itemText);
    const form = buildForm(filters);

    if (parsed.items.length) {
      const result = getBulkItemRows(parsed.items, filters);
      const displayRows = filters.showOnlyIssues ?
        result.rows.filter((row) => isIssueStatus(row.status)) :
        result.rows;
      addSummary(form, {
        requestedCount: parsed.items.length,
        duplicateCount: parsed.duplicateCount,
        skippedCount: parsed.skippedCount,
        rows: result.rows,
        shownCount: displayRows.length,
        errorMessage: result.errorMessage,
        hasLocation: Boolean(filters.locationId),
        showOnlyIssues: filters.showOnlyIssues
      });
      addResultsSublist(form, displayRows);
    } else {
      addIntroMessage(form);
    }

    context.response.writePage(form);
  }

  function buildForm(filters) {
    const form = serverWidget.createForm({
      title: 'Bulk Item Cost and First Transaction Check'
    });

    const filterGroup = form.addFieldGroup({
      id: 'custpage_filters_group',
      label: 'Bulk Check'
    });

    const itemField = form.addField({
      id: PARAMS.items,
      type: serverWidget.FieldType.LONGTEXT,
      label: 'Item Numbers',
      container: 'custpage_filters_group'
    });
    itemField.defaultValue = filters.itemText;
    try {
      itemField.updateDisplaySize({ height: 14, width: 100 });
    } catch (e) {
      // Display sizing is only a form hint.
    }

    const locationField = form.addField({
      id: PARAMS.location,
      type: serverWidget.FieldType.SELECT,
      label: 'Location for Standard Cost',
      source: 'location',
      container: 'custpage_filters_group'
    });
    locationField.defaultValue = filters.locationId;

    const inactiveField = form.addField({
      id: PARAMS.includeInactive,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Include Inactive Items',
      container: 'custpage_filters_group'
    });
    inactiveField.defaultValue = filters.includeInactive ? 'T' : 'F';

    const issueOnlyField = form.addField({
      id: PARAMS.showOnlyIssues,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Show Only Issues',
      container: 'custpage_filters_group'
    });
    issueOnlyField.defaultValue = filters.showOnlyIssues ? 'T' : 'F';

    form.addSubmitButton({ label: 'Check Items' });
    return form;
  }

  function addIntroMessage(form) {
    const field = form.addField({
      id: 'custpage_intro',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Instructions'
    });

    field.defaultValue =
      '<div style="margin:12px 0;padding:10px 12px;border-left:5px solid #2f5f8f;background:#f4f8fb;color:#1f2d3d;">' +
      'Paste item numbers separated by commas or new lines, then click <b>Check Items</b>. ' +
      'The report shows item costing fields, optional location standard cost, and whether the first inventory-affecting transaction is Inventory Revaluation.' +
      '</div>';
  }

  function addSummary(form, opts) {
    const rows = opts.rows || [];
    const foundCount = rows.filter((row) => row.itemInternalId).length;
    const notFoundCount = rows.filter((row) => !row.itemInternalId).length;
    const issueCount = rows.filter((row) => isIssueStatus(row.status)).length;
    const firstTranIssueCount = rows.filter((row) => {
      return row.itemInternalId && row.firstTransactionTypeId && row.firstTransactionTypeId !== 'InvReval';
    }).length;

    const field = form.addField({
      id: 'custpage_summary',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Summary'
    });

    let html = '' +
      '<style>' +
      '.pq-bulk-summary{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:9px;margin:14px 0;max-width:1100px;}' +
      '.pq-bulk-card{border:1px solid #d8d8d8;background:#fff;border-radius:4px;padding:9px 11px;min-height:54px;}' +
      '.pq-bulk-label{font-size:11px;text-transform:uppercase;color:#666;margin-bottom:4px;}' +
      '.pq-bulk-value{font-size:18px;font-weight:700;color:#222;line-height:1.2;}' +
      '.pq-bulk-alert{border-color:#e2a5a5;background:#fff5f5;}' +
      '.pq-bulk-ok{border-color:#abcfae;background:#f3fbf4;}' +
      '.pq-bulk-note{margin:6px 0 12px;color:#555;}' +
      '.pq-bulk-error{margin:10px 0;padding:10px 12px;border-left:5px solid #b00020;background:#fff1f1;color:#6e1111;font-weight:700;}' +
      '@media(max-width:900px){.pq-bulk-summary{grid-template-columns:repeat(2,minmax(130px,1fr));}}' +
      '</style>' +
      '<div class="pq-bulk-summary">' +
      summaryCard('Requested', opts.requestedCount, '') +
      summaryCard('Found', foundCount, foundCount ? 'pq-bulk-ok' : 'pq-bulk-alert') +
      summaryCard('Not Found', notFoundCount, notFoundCount ? 'pq-bulk-alert' : 'pq-bulk-ok') +
      summaryCard('Cost/Setup Issues', issueCount, issueCount ? 'pq-bulk-alert' : 'pq-bulk-ok') +
      summaryCard('First Tran Issues', firstTranIssueCount, firstTranIssueCount ? 'pq-bulk-alert' : 'pq-bulk-ok') +
      '</div>';

    html += '<div class="pq-bulk-note"><b>Rows shown:</b> ' + escapeHtml(opts.shownCount) +
      (opts.showOnlyIssues ? ' issue row' + (opts.shownCount === 1 ? '' : 's') + '. Clear "Show Only Issues" to display all requested items.' : ' of ' + escapeHtml(rows.length) + ' requested item rows.') +
      '</div>';

    if (opts.errorMessage) {
      html += '<div class="pq-bulk-error">' + escapeHtml(opts.errorMessage) + '</div>';
    }

    const notes = [];
    if (opts.duplicateCount) {
      notes.push(opts.duplicateCount + ' duplicate pasted item number' + (opts.duplicateCount === 1 ? '' : 's') + ' removed.');
    }
    if (opts.skippedCount) {
      notes.push('Only the first ' + MAX_ITEMS + ' unique item numbers were checked; ' + opts.skippedCount + ' were skipped.');
    }
    if (!opts.hasLocation) {
      notes.push('Select a location when you need location standard cost and location Inventory Revaluation status.');
    }

    if (notes.length) {
      html += '<div class="pq-bulk-note">' + notes.map(escapeHtml).join('<br>') + '</div>';
    }

    field.defaultValue = html;
  }

  function summaryCard(label, value, extraClass) {
    return '<div class="pq-bulk-card ' + escapeHtml(extraClass || '') + '">' +
      '<div class="pq-bulk-label">' + escapeHtml(label) + '</div>' +
      '<div class="pq-bulk-value">' + escapeHtml(value) + '</div>' +
      '</div>';
  }

  function addResultsSublist(form, rows) {
    const sublist = form.addSublist({
      id: 'custpage_results',
      type: serverWidget.SublistType.LIST,
      label: 'Bulk Item Cost Results'
    });

    sublist.addField({ id: 'requested', type: serverWidget.FieldType.TEXT, label: 'Requested Item' });
    sublist.addField({ id: 'status', type: serverWidget.FieldType.TEXT, label: 'Status' });
    sublist.addField({ id: 'internalid', type: serverWidget.FieldType.TEXT, label: 'Item Internal ID' });
    sublist.addField({ id: 'itemid', type: serverWidget.FieldType.TEXT, label: 'Item Name/Number' });
    sublist.addField({ id: 'displayname', type: serverWidget.FieldType.TEXT, label: 'Display Name' });
    sublist.addField({ id: 'itemtype', type: serverWidget.FieldType.TEXT, label: 'Item Type' });
    sublist.addField({ id: 'costmethod', type: serverWidget.FieldType.TEXT, label: 'Costing Method' });
    sublist.addField({ id: 'itemcost', type: serverWidget.FieldType.TEXT, label: 'Item Cost' });
    sublist.addField({ id: 'avgcost', type: serverWidget.FieldType.TEXT, label: 'Average Cost' });
    sublist.addField({ id: 'lastpurch', type: serverWidget.FieldType.TEXT, label: 'Last Purchase Price' });
    sublist.addField({ id: 'loc', type: serverWidget.FieldType.TEXT, label: 'Location' });
    sublist.addField({ id: 'stdcost', type: serverWidget.FieldType.TEXT, label: 'Std Cost @ Location' });
    sublist.addField({ id: 'onhand', type: serverWidget.FieldType.TEXT, label: 'Qty On Hand' });
    sublist.addField({ id: 'available', type: serverWidget.FieldType.TEXT, label: 'Qty Available' });
    sublist.addField({ id: 'firstdate', type: serverWidget.FieldType.TEXT, label: 'First Tran Date' });
    sublist.addField({ id: 'firsttype', type: serverWidget.FieldType.TEXT, label: 'First Tran Type' });
    sublist.addField({ id: 'firstdoc', type: serverWidget.FieldType.TEXT, label: 'First Tran Number' });
    sublist.addField({ id: 'firstloc', type: serverWidget.FieldType.TEXT, label: 'First Tran Location' });
    sublist.addField({ id: 'revaldate', type: serverWidget.FieldType.TEXT, label: 'Latest InvReval @ Location' });
    sublist.addField({ id: 'revaldoc', type: serverWidget.FieldType.TEXT, label: 'InvReval Number @ Location' });

    rows.forEach((row, line) => {
      setSublistValue(sublist, 'requested', line, row.requestedItem);
      setSublistValue(sublist, 'status', line, row.status);
      setSublistValue(sublist, 'internalid', line, row.itemInternalId);
      setSublistValue(sublist, 'itemid', line, row.itemId);
      setSublistValue(sublist, 'displayname', line, row.displayName);
      setSublistValue(sublist, 'itemtype', line, row.itemType);
      setSublistValue(sublist, 'costmethod', line, row.costingMethod);
      setSublistValue(sublist, 'itemcost', line, row.itemCost);
      setSublistValue(sublist, 'avgcost', line, row.averageCost);
      setSublistValue(sublist, 'lastpurch', line, row.lastPurchasePrice);
      setSublistValue(sublist, 'loc', line, row.location);
      setSublistValue(sublist, 'stdcost', line, row.standardCost);
      setSublistValue(sublist, 'onhand', line, row.qtyOnHand);
      setSublistValue(sublist, 'available', line, row.qtyAvailable);
      setSublistValue(sublist, 'firstdate', line, row.firstTransactionDate);
      setSublistValue(sublist, 'firsttype', line, row.firstTransactionType);
      setSublistValue(sublist, 'firstdoc', line, row.firstTransactionNumber);
      setSublistValue(sublist, 'firstloc', line, row.firstTransactionLocation);
      setSublistValue(sublist, 'revaldate', line, row.locationRevalDate);
      setSublistValue(sublist, 'revaldoc', line, row.locationRevalNumber);
    });
  }

  function getBulkItemRows(itemNumbers, filters) {
    const result = {
      rows: [],
      errorMessage: ''
    };

    try {
      const itemMap = getItemInfoMapByNumber(itemNumbers, filters.includeInactive);
      const itemIds = unique(Object.keys(itemMap).map((key) => itemMap[key].itemInternalId).filter(Boolean));
      const firstTransactionMap = getFirstTransactionMap(itemIds);
      const locationCostMap = filters.locationId ? getLocationCostMap(itemIds, filters.locationId) : {};
      const locationRevalMap = filters.locationId ? getLatestLocationRevalMap(itemIds, filters.locationId) : {};

      result.rows = itemNumbers.map((requestedItem) => {
        const info = itemMap[normalizeKey(requestedItem)] || {};
        const first = info.itemInternalId ? firstTransactionMap[info.itemInternalId] || {} : {};
        const locationCost = info.itemInternalId ? locationCostMap[info.itemInternalId] || {} : {};
        const locationReval = info.itemInternalId ? locationRevalMap[info.itemInternalId] || {} : {};

        const row = {
          requestedItem,
          itemInternalId: info.itemInternalId || '',
          itemId: info.itemId || '',
          displayName: info.displayName || '',
          itemTypeValue: info.itemTypeValue || '',
          itemType: info.itemType || '',
          costingMethod: info.costingMethod || '',
          itemCost: info.itemCost || '',
          averageCost: info.averageCost || '',
          lastPurchasePrice: info.lastPurchasePrice || '',
          isInactive: info.isInactive || '',
          location: locationCost.location || '',
          standardCost: locationCost.standardCost || '',
          qtyOnHand: locationCost.qtyOnHand || '',
          qtyAvailable: locationCost.qtyAvailable || '',
          firstTransactionTypeId: first.typeId || '',
          firstTransactionType: first.typeText || '',
          firstTransactionDate: first.date || '',
          firstTransactionNumber: first.number || '',
          firstTransactionLocation: first.location || '',
          locationRevalDate: locationReval.date || '',
          locationRevalNumber: locationReval.number || ''
        };

        row.status = getRowStatus(row, Boolean(filters.locationId));
        return row;
      });
    } catch (e) {
      log.error('Bulk item cost check failed', e);
      result.errorMessage = e.name + ': ' + e.message;
      result.rows = itemNumbers.map((requestedItem) => ({
        requestedItem,
        status: 'Error running check'
      }));
    }

    return result;
  }

  function getItemInfoMapByNumber(itemNumbers, includeInactive) {
    try {
      return searchItemsByNumberField(itemNumbers, includeInactive, 'itemid');
    } catch (e) {
      log.audit('Item lookup by itemid failed; retrying with name filter', e);
      return searchItemsByNumberField(itemNumbers, includeInactive, 'name');
    }
  }

  function searchItemsByNumberField(itemNumbers, includeInactive, fieldName) {
    const out = {};

    chunk(itemNumbers, NAME_FILTER_CHUNK).forEach((names) => {
      const itemSearch = search.create({
        type: search.Type.ITEM,
        filters: buildItemNumberFilters(names, includeInactive, fieldName),
        columns: [
          search.createColumn({ name: 'itemid', sort: search.Sort.ASC }),
          'internalid',
          'displayname',
          'type',
          'costingmethod',
          'cost',
          'averagecost',
          'lastpurchaseprice',
          'isinactive'
        ]
      });

      forEachSearchResult(itemSearch, (r) => {
        const itemId = safeSearchValue(r, 'itemid');
        const key = normalizeKey(itemId);

        if (key) {
          out[key] = {
            itemInternalId: safeSearchValue(r, 'internalid'),
            itemId,
            displayName: safeSearchValue(r, 'displayname'),
            itemTypeValue: safeSearchValue(r, 'type'),
            itemType: safeSearchText(r, 'type') || safeSearchValue(r, 'type'),
            costingMethod: safeSearchText(r, 'costingmethod') || safeSearchValue(r, 'costingmethod'),
            itemCost: formatNumber(safeSearchValue(r, 'cost')),
            averageCost: formatNumber(safeSearchValue(r, 'averagecost')),
            lastPurchasePrice: formatNumber(safeSearchValue(r, 'lastpurchaseprice')),
            isInactive: isTrue(safeSearchValue(r, 'isinactive')) ? 'Yes' : 'No'
          };
        }
      });
    });

    return out;
  }

  function buildItemNumberFilters(names, includeInactive, fieldName) {
    const nameFilters = [];

    names.forEach((name, index) => {
      if (index > 0) {
        nameFilters.push('OR');
      }
      nameFilters.push([fieldName, 'is', name]);
    });

    if (includeInactive) {
      return nameFilters;
    }

    return [nameFilters, 'AND', ['isinactive', 'is', 'F']];
  }

  function getLocationCostMap(itemIds, locationId) {
    const out = {};

    chunk(itemIds, ID_CHUNK).forEach((ids) => {
      const itemSearch = search.create({
        type: search.Type.ITEM,
        filters: [
          ['internalid', 'anyof', ids],
          'AND',
          ['inventorylocation', 'anyof', locationId]
        ],
        columns: [
          'internalid',
          'itemid',
          'inventorylocation',
          'cost',
          'locationquantityonhand',
          'locationquantityavailable'
        ]
      });

      forEachSearchResult(itemSearch, (r) => {
        const id = safeSearchValue(r, 'internalid');
        if (id) {
          out[id] = {
            itemInternalId: id,
            itemId: safeSearchValue(r, 'itemid'),
            location: safeSearchText(r, 'inventorylocation') || safeSearchValue(r, 'inventorylocation'),
            standardCost: formatNumber(safeSearchValue(r, 'cost')),
            qtyOnHand: formatNumber(safeSearchValue(r, 'locationquantityonhand')),
            qtyAvailable: formatNumber(safeSearchValue(r, 'locationquantityavailable'))
          };
        }
      });
    });

    return out;
  }

  function getLatestLocationRevalMap(itemIds, locationId) {
    const out = {};

    chunk(itemIds, ID_CHUNK).forEach((ids) => {
      const tranSearch = search.create({
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
          'item',
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'internalid', sort: search.Sort.DESC }),
          'tranid'
        ]
      });

      forEachSearchResult(tranSearch, (r) => {
        const itemId = safeSearchValue(r, 'item');

        if (itemId && !out[itemId]) {
          out[itemId] = {
            date: safeSearchValue(r, 'trandate'),
            number: safeSearchValue(r, 'tranid') || safeSearchValue(r, 'internalid')
          };
        }
      });
    });

    return out;
  }

  function getFirstTransactionMap(itemIds) {
    const out = {};

    chunk(itemIds, ID_CHUNK).forEach((ids) => {
      const numericIds = ids.map((id) => Number(id)).filter((id) => !isNaN(id));
      if (!numericIds.length) {
        return;
      }

      const sql = `
        SELECT *
        FROM (
          SELECT
            i.id AS item_internal_id,
            t.id AS first_transaction_internal_id,
            t.trandate AS first_transaction_date,
            t.tranid AS first_transaction_number,
            t.type AS first_transaction_type_id,
            BUILTIN.DF(t.type) AS first_transaction_type,
            BUILTIN.DF(tl.location) AS first_transaction_location,
            ROW_NUMBER() OVER (
              PARTITION BY i.id
              ORDER BY t.trandate ASC, t.id ASC
            ) AS rn
          FROM
            transactionline tl
            JOIN transaction t ON t.id = tl.transaction
            JOIN item i ON i.id = tl.item
          WHERE
            i.id IN (${numericIds.join(',')})
            AND NVL(t.voided, 'F') = 'F'
            AND NVL(t.posting, 'F') = 'T'
            AND NVL(tl.isinventoryaffecting, 'F') = 'T'
        )
        WHERE rn = 1
      `;

      const paged = query.runSuiteQLPaged({
        query: sql,
        pageSize: 1000
      });

      paged.pageRanges.forEach((pageRange) => {
        const page = paged.fetch({ index: pageRange.index });

        page.data.asMappedResults().forEach((row) => {
          const itemId = String(row.item_internal_id || '');

          if (itemId) {
            out[itemId] = {
              date: String(row.first_transaction_date || ''),
              number: String(row.first_transaction_number || row.first_transaction_internal_id || ''),
              typeId: String(row.first_transaction_type_id || ''),
              typeText: String(row.first_transaction_type || row.first_transaction_type_id || ''),
              location: String(row.first_transaction_location || '')
            };
          }
        });
      });
    });

    return out;
  }

  function getRowStatus(row, hasLocation) {
    if (!row.itemInternalId) {
      return 'Item not found';
    }

    if (!isInventoryOrAssembly(row)) {
      return 'Not inventory/assembly';
    }

    if (!isStandardCosting(row.costingMethod)) {
      return 'Not standard cost item';
    }

    if (!row.firstTransactionTypeId) {
      return 'No inventory transactions';
    }

    if (row.firstTransactionTypeId !== 'InvReval') {
      return 'First transaction not Inventory Revaluation';
    }

    if (hasLocation && !row.locationRevalDate) {
      return 'No Inventory Revaluation at selected location';
    }

    if (hasLocation && !hasValue(row.standardCost)) {
      return 'No standard cost at selected location';
    }

    return 'OK';
  }

  function isIssueStatus(status) {
    return status !== 'OK' && status !== 'Not standard cost item' && status !== 'Not inventory/assembly';
  }

  function isInventoryOrAssembly(row) {
    const value = clean(row.itemTypeValue);
    const text = clean(row.itemType).toLowerCase();

    return value === 'InvtPart' ||
      value === 'Assembly' ||
      text.indexOf('inventory') !== -1 ||
      text.indexOf('assembly') !== -1;
  }

  function isStandardCosting(costingMethod) {
    const text = clean(costingMethod).toLowerCase();
    return text.indexOf('standard') !== -1 || text === 'std';
  }

  function parseItemNumbers(text) {
    const rawTokens = String(text || '')
      .split(/[\n\r,;\t]+/)
      .map(normalizeItemToken)
      .filter(Boolean);

    const seen = {};
    const items = [];
    let duplicateCount = 0;

    rawTokens.forEach((token) => {
      const key = normalizeKey(token);
      if (!key) {
        return;
      }

      if (seen[key]) {
        duplicateCount += 1;
        return;
      }

      seen[key] = true;
      items.push(token);
    });

    return {
      items: items.slice(0, MAX_ITEMS),
      duplicateCount,
      skippedCount: Math.max(items.length - MAX_ITEMS, 0)
    };
  }

  function normalizeItemToken(token) {
    const text = clean(token).replace(/^['"]|['"]$/g, '');

    if (!text) {
      return '';
    }

    const parts = text.split(/\s+/).filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';

    if (parts.length > 1 && /^[A-Za-z0-9_.:-]+$/.test(lastPart)) {
      return lastPart;
    }

    return text;
  }

  function normalizeFilters(params) {
    const hasShowOnlyIssuesParam = Object.prototype.hasOwnProperty.call(params, PARAMS.showOnlyIssues) ||
      Object.prototype.hasOwnProperty.call(params, 'showonlyissues');
    const showOnlyIssuesValue = params[PARAMS.showOnlyIssues] || params.showonlyissues;

    return {
      itemText: String(params[PARAMS.items] || params.items || ''),
      locationId: clean(params[PARAMS.location] || params.location || params.locationid),
      includeInactive: params[PARAMS.includeInactive] === 'T' || params.includeinactive === 'T',
      showOnlyIssues: hasShowOnlyIssuesParam ? showOnlyIssuesValue === 'T' : true
    };
  }

  function safeSearchValue(result, name) {
    try {
      const value = result.getValue({ name });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function safeSearchText(result, name) {
    try {
      const value = result.getText({ name });
      return value == null ? '' : String(value);
    } catch (e) {
      return '';
    }
  }

  function forEachSearchResult(nsSearch, callback) {
    const paged = nsSearch.runPaged({ pageSize: 1000 });

    paged.pageRanges.forEach((pageRange) => {
      const page = paged.fetch({ index: pageRange.index });
      page.data.forEach((result) => {
        callback(result);
      });
    });
  }

  function setSublistValue(sublist, id, line, value) {
    if (!hasValue(value)) {
      return;
    }

    sublist.setSublistValue({
      id,
      line,
      value: String(value).slice(0, 300)
    });
  }

  function hasValue(value) {
    return value !== null && value !== undefined && String(value) !== '';
  }

  function formatNumber(value) {
    if (!hasValue(value)) {
      return '';
    }

    const number = Number(String(value).replace(/,/g, ''));
    if (isNaN(number)) {
      return String(value);
    }

    return String(number);
  }

  function isTrue(value) {
    return value === true || value === 'T' || value === 'true';
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

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeKey(value) {
    return clean(value).toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return { onRequest };
});
