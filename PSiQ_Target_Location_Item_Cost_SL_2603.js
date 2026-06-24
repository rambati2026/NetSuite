/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * Developer: Ramakrishna Ambati
 * Date: 2026-06-24
 * Version: 2026.06.24.9
 * Description: One Suitelet to report and optionally apply missing item cost
 * for selected inventory locations.
 */
define(['N/ui/serverWidget', 'N/search', 'N/runtime', 'N/url', 'N/record', 'N/query'], (
  serverWidget,
  search,
  runtime,
  url,
  record,
  query
) => {
  const DEFAULT_TARGET_LOCATIONS = [
    'Operation (Hillview) Warehouse',
    'Operation (Samina) Warehouse',
    'Operation (Hansen) Warehouse'
  ];

  const PAGE_SIZE = 1000;
  const MAX_SCREEN_ROWS = 1000;
  const CSV_CHUNK_SIZE = 1000;
  const MAX_CSV_ROWS = 50000;
  const MAX_APPLY_ITEMS = 200;

  const PARAMS = {
    locations: 'custpage_locations',
    itemType: 'custpage_item_type',
    includeInactive: 'custpage_include_inactive',
    onlyStandard: 'custpage_only_standard',
    zeroMissing: 'custpage_zero_missing',
    sourceCostField: 'custpage_source_cost_field',
    action: 'custpage_action',
    exportCsv: 'custpage_export',
    defaultLocations: 'custscript_psiq_item_cost_locations'
  };

  const ACTIONS = {
    report: 'REPORT',
    apply: 'APPLY'
  };

  const LOCATION_SUBLIST = 'locations';
  const LOCATION_FIELD = 'location';
  const LOCATION_COST_FIELD = 'cost';

  function onRequest(context) {
    const request = context.request;
    const filters = normalizeFilters(request.parameters);
    const shouldRun = request.method === 'POST' || filters.exportCsv;

    if (!shouldRun) {
      const form = buildForm(filters);
      addIntro(form);
      context.response.writePage(form);
      return;
    }

    let report = buildMissingCostReport(filters);
    let applySummary = null;

    if (filters.action === ACTIONS.apply && !filters.exportCsv) {
      applySummary = applyMissingCosts(report.rows, filters);
      report = buildMissingCostReport(filters);
    }

    if (filters.exportCsv) {
      writeCsv(context.response, report.rows);
      return;
    }

    const form = buildForm(filters);
    addMessage(form, report, applySummary);
    addResultsSublist(form, report.rows);
    context.response.writePage(form);
  }

  function buildForm(filters) {
    const form = serverWidget.createForm({
      title: 'Target Location Item Cost'
    });

    const filterGroup = form.addFieldGroup({
      id: 'custpage_filters_group',
      label: 'Filters'
    });

    const locationFld = form.addField({
      id: PARAMS.locations,
      type: serverWidget.FieldType.MULTISELECT,
      label: 'Target Locations',
      source: 'location',
      container: 'custpage_filters_group'
    });
    const selectedLocationIds = getSelectedLocationIds(filters.locationText);
    if (selectedLocationIds.length) {
      locationFld.defaultValue = selectedLocationIds;
    }

    const itemTypeFld = form.addField({
      id: PARAMS.itemType,
      type: serverWidget.FieldType.SELECT,
      label: 'Item Type',
      container: 'custpage_filters_group'
    });
    itemTypeFld.addSelectOption({ value: '', text: '- Inventory and Assembly -' });
    itemTypeFld.addSelectOption({ value: 'InvtPart', text: 'Inventory Item' });
    itemTypeFld.addSelectOption({ value: 'Assembly', text: 'Assembly Item' });
    itemTypeFld.defaultValue = filters.itemType;

    const onlyStandardFld = form.addField({
      id: PARAMS.onlyStandard,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Only Standard Cost Items',
      container: 'custpage_filters_group'
    });
    onlyStandardFld.defaultValue = filters.onlyStandard ? 'T' : 'F';

    const zeroMissingFld = form.addField({
      id: PARAMS.zeroMissing,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Treat Zero Cost as Missing',
      container: 'custpage_filters_group'
    });
    zeroMissingFld.defaultValue = filters.zeroMissing ? 'T' : 'F';

    const inactiveFld = form.addField({
      id: PARAMS.includeInactive,
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Include Inactive Items',
      container: 'custpage_filters_group'
    });
    inactiveFld.defaultValue = filters.includeInactive ? 'T' : 'F';

    const sourceCostFld = form.addField({
      id: PARAMS.sourceCostField,
      type: serverWidget.FieldType.TEXT,
      label: 'Source Item Cost Field',
      container: 'custpage_filters_group'
    });
    sourceCostFld.defaultValue = filters.sourceCostField;

    const actionFld = form.addField({
      id: PARAMS.action,
      type: serverWidget.FieldType.SELECT,
      label: 'Action',
      container: 'custpage_filters_group'
    });
    actionFld.addSelectOption({ value: ACTIONS.report, text: 'Report Missing Costs Only' });
    actionFld.addSelectOption({ value: ACTIONS.apply, text: 'Apply Source Cost to Missing Location Rows' });
    actionFld.defaultValue = filters.action;

    form.addSubmitButton({ label: 'Run' });

    return form;
  }

  function addIntro(form) {
    const fld = form.addField({
      id: 'custpage_intro',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Instructions'
    });

    fld.defaultValue =
      '<div style="margin:12px 0;">Select one or more target locations. The report treats an Inventory Cost Revaluation / Standard Cost row at the selected location as existing cost. Use the CSV link after running the report to export the complete file.</div>';
  }

  function addMessage(form, report, applySummary) {
    const totalRows = report.totalRows == null ? report.rows.length : report.totalRows;
    const shown = Math.min(report.rows.length, MAX_SCREEN_ROWS);
    const csvUrl = buildCsvUrl(report.filters);
    const unresolved = report.unresolvedLocations.length ?
      '<div style="margin-top:6px;color:#9a5b00;"><b>Unmatched locations:</b> ' +
      escapeHtml(report.unresolvedLocations.join(', ')) + '</div>' :
      '';
    const applyHtml = applySummary ? buildApplySummaryHtml(applySummary) : '';

    let html =
      '<div style="margin:12px 0;padding:10px 12px;border-left:5px solid #376092;background:#f4f8ff;">' +
      applyHtml +
      '<div><b>Remaining missing rows:</b> ' + escapeHtml(totalRows) +
      ' <span style="color:#666;">Shown on page: ' + escapeHtml(shown) + '</span></div>' +
      '<div style="margin-top:4px;"><b>Locations checked:</b> ' +
      escapeHtml(report.locations.map((loc) => loc.name + ' (' + loc.id + ')').join(', ') || 'None') +
      '</div>' +
      unresolved;

    if (csvUrl) {
      html += '<div style="margin-top:8px;"><a href="' + escapeAttr(csvUrl) +
        '" style="font-weight:700;">Export complete CSV file</a></div>';
    }

    html += '</div>';

    const fld = form.addField({
      id: 'custpage_message',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Status'
    });
    fld.defaultValue = html;
  }

  function buildApplySummaryHtml(summary) {
    let html =
      '<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #cbd7ea;">' +
      '<b>Apply complete.</b> Items updated: ' + escapeHtml(summary.itemsUpdated) +
      ', location rows updated: ' + escapeHtml(summary.locationRowsUpdated) +
      ', skipped: ' + escapeHtml(summary.skipped.length) +
      ', errors: ' + escapeHtml(summary.errors.length) + '.';

    if (summary.limited) {
      html += ' <span style="color:#9a5b00;">Apply stopped after ' + MAX_APPLY_ITEMS +
        ' items to avoid Suitelet timeout. Run again for the remaining rows.</span>';
    }

    if (summary.errors.length) {
      html += '<div style="margin-top:5px;color:#b00020;">First error: ' +
        escapeHtml(summary.errors[0].message) + '</div>';
    }

    html += '</div>';
    return html;
  }

  function addResultsSublist(form, rows) {
    const sublist = form.addSublist({
      id: 'custpage_results',
      type: serverWidget.SublistType.LIST,
      label: 'Missing Item Cost Rows'
    });

    sublist.addField({ id: 'item_internal_id', type: serverWidget.FieldType.TEXT, label: 'Item Internal ID' });
    sublist.addField({ id: 'itemid', type: serverWidget.FieldType.TEXT, label: 'Item Name/Number' });
    sublist.addField({ id: 'displayname', type: serverWidget.FieldType.TEXT, label: 'Display Name' });
    sublist.addField({ id: 'itemtype', type: serverWidget.FieldType.TEXT, label: 'Item Type' });
    sublist.addField({ id: 'costingmethod', type: serverWidget.FieldType.TEXT, label: 'Costing Method' });
    sublist.addField({ id: 'sourcecost', type: serverWidget.FieldType.TEXT, label: 'Source Cost' });
    sublist.addField({ id: 'location_id', type: serverWidget.FieldType.TEXT, label: 'Location ID' });
    sublist.addField({ id: 'location', type: serverWidget.FieldType.TEXT, label: 'Location' });
    sublist.addField({ id: 'status', type: serverWidget.FieldType.TEXT, label: 'Missing Reason' });
    sublist.addField({ id: 'cost', type: serverWidget.FieldType.TEXT, label: 'Current Location Cost' });

    rows.slice(0, MAX_SCREEN_ROWS).forEach((row, line) => {
      setSublistValue(sublist, 'item_internal_id', line, row.itemInternalId);
      setSublistValue(sublist, 'itemid', line, row.itemId);
      setSublistValue(sublist, 'displayname', line, row.displayName);
      setSublistValue(sublist, 'itemtype', line, row.itemType);
      setSublistValue(sublist, 'costingmethod', line, row.costingMethod);
      setSublistValue(sublist, 'sourcecost', line, row.sourceCost);
      setSublistValue(sublist, 'location_id', line, row.locationId);
      setSublistValue(sublist, 'location', line, row.locationName);
      setSublistValue(sublist, 'status', line, row.status);
      setSublistValue(sublist, 'cost', line, row.currentCost);
    });
  }

  function buildMissingCostReport(filters) {
    const locationResult = getRequestedLocations(filters.locationText);
    const locations = locationResult.locations;

    if (!locations.length) {
      return {
        filters,
        locations,
        unresolvedLocations: locationResult.unresolved,
        rows: [],
        totalRows: 0
      };
    }

    const sql = buildMissingCostSuiteQl(filters, locations);
    const result = filters.exportCsv ? runCompleteMissingCostQuery(sql) : runScreenMissingCostQuery(sql);

    return {
      filters,
      locations,
      unresolvedLocations: locationResult.unresolved,
      rows: result.rows,
      totalRows: result.totalRows
    };
  }

  function runScreenMissingCostQuery(sql) {
    const cappedSql = 'SELECT * FROM (' + sql + ') WHERE ROWNUM <= ' + MAX_SCREEN_ROWS;
    const rows = query.runSuiteQL({ query: cappedSql }).asMappedResults().map(mapMissingCostRow);

    return {
      rows,
      totalRows: rows.length >= MAX_SCREEN_ROWS ? String(MAX_SCREEN_ROWS) + '+' : rows.length
    };
  }

  function runCompleteMissingCostQuery(sql) {
    const rows = [];
    let start = 0;
    let keepGoing = true;

    while (keepGoing && rows.length < MAX_CSV_ROWS) {
      const end = start + CSV_CHUNK_SIZE;
      const chunkSql = "" +
        "SELECT * FROM (" +
          "SELECT base_query.*, ROWNUM AS csv_rownum FROM (" + sql + ") base_query " +
          "WHERE ROWNUM <= " + end +
        ") WHERE csv_rownum > " + start;
      const chunkRows = query.runSuiteQL({ query: chunkSql }).asMappedResults();

      chunkRows.forEach((row) => {
        if (rows.length < MAX_CSV_ROWS) {
          rows.push(mapMissingCostRow(row));
        }
      });

      keepGoing = chunkRows.length === CSV_CHUNK_SIZE;
      start = end;
    }

    return {
      rows,
      totalRows: rows.length >= MAX_CSV_ROWS ? String(MAX_CSV_ROWS) + '+' : rows.length
    };
  }

  function mapMissingCostRow(row) {
    return {
      itemInternalId: clean(row.item_internal_id),
      itemId: clean(row.itemid),
      displayName: clean(row.display_name),
      itemTypeValue: clean(row.item_type_value),
      itemType: clean(row.item_type),
      recordType: '',
      costingMethod: clean(row.costing_method),
      sourceCost: clean(row.source_cost),
      locationId: clean(row.location_id),
      locationName: clean(row.location_name),
      status: clean(row.status) || 'No standard cost row',
      currentCost: ''
    };
  }

  function buildMissingCostSuiteQl(filters, locations) {
    const locationSql = locations.map((location) => {
      return 'SELECT ' + Number(location.id) + ' AS location_id, ' +
        sqlString(location.name) + ' AS location_name FROM dual';
    }).join(' UNION ALL ');
    const locationIdSql = locations.map((location) => Number(location.id)).join(', ');

    const where = [
      "i.itemtype IN (" + getSuiteQlItemTypes(filters).map(sqlString).join(', ') + ")",
      "reval.item_id IS NULL"
    ];

    if (!filters.includeInactive) {
      where.push("NVL(i.isinactive, 'F') = 'F'");
    }

    if (filters.onlyStandard) {
      where.push("(" +
        "UPPER(BUILTIN.DF(i.costingmethod)) LIKE '%STANDARD%' " +
        "OR UPPER(i.costingmethod) LIKE '%STANDARD%' " +
        "OR UPPER(i.costingmethod) = 'STD'" +
      ")");
    }

    return "" +
      "SELECT " +
        "i.id AS item_internal_id, " +
        "i.itemid AS itemid, " +
        "i.displayname AS display_name, " +
        "i.itemtype AS item_type_value, " +
        "BUILTIN.DF(i.itemtype) AS item_type, " +
        "BUILTIN.DF(i.costingmethod) AS costing_method, " +
        "i.cost AS source_cost, " +
        "loc.location_id AS location_id, " +
        "loc.location_name AS location_name, " +
        "'No standard cost row' AS status " +
      "FROM item i " +
      "JOIN (" + locationSql + ") loc ON 1 = 1 " +
      "LEFT JOIN (" +
        "SELECT tl.item AS item_id, tl.location AS location_id " +
        "FROM transactionline tl " +
        "JOIN transaction t ON t.id = tl.transaction " +
        "WHERE t.type = 'InvReval' " +
        "AND NVL(t.voided, 'F') = 'F' " +
        "AND tl.item IS NOT NULL " +
        "AND tl.location IN (" + locationIdSql + ") " +
        "GROUP BY tl.item, tl.location" +
      ") reval ON reval.item_id = i.id AND reval.location_id = loc.location_id " +
      "WHERE " + where.join(' AND ') + " " +
      "ORDER BY i.itemid, loc.location_name";
  }

  function getSuiteQlItemTypes(filters) {
    if (filters.itemType) {
      return [filters.itemType];
    }

    return ['InvtPart', 'Assembly'];
  }

  function sqlString(value) {
    return "'" + clean(value).replace(/'/g, "''") + "'";
  }

  function applyMissingCosts(rows, filters) {
    const rowsByItem = groupRowsByItem(rows);
    const itemIds = Object.keys(rowsByItem);
    const summary = {
      itemsUpdated: 0,
      locationRowsUpdated: 0,
      skipped: [],
      errors: [],
      limited: itemIds.length > MAX_APPLY_ITEMS
    };

    itemIds.slice(0, MAX_APPLY_ITEMS).forEach((itemId) => {
      const itemRows = rowsByItem[itemId];
      const first = itemRows[0];
      const recordType = getItemRecordType(first);

      if (!recordType) {
        summary.errors.push({
          itemId,
          message: 'Unsupported item type for ' + first.itemType
        });
        return;
      }

      try {
        const itemRec = record.load({
          type: recordType,
          id: itemId,
          isDynamic: false
        });
        const sourceCost = toNumber(safeGetValue(itemRec, filters.sourceCostField));

        if (!isValidApplyCost(sourceCost)) {
          summary.skipped.push({
            itemId,
            message: 'Source cost is blank or zero for item ' + first.itemId
          });
          return;
        }

        const locationSet = {};
        itemRows.forEach((row) => {
          locationSet[row.locationId] = true;
        });

        const updated = updateItemLocationRows(itemRec, locationSet, sourceCost, filters.zeroMissing);

        if (!updated) {
          summary.skipped.push({
            itemId,
            message: 'No editable matching location row found for item ' + first.itemId
          });
          return;
        }

        itemRec.save({
          enableSourcing: false,
          ignoreMandatoryFields: true
        });

        summary.itemsUpdated += 1;
        summary.locationRowsUpdated += updated;
      } catch (e) {
        summary.errors.push({
          itemId,
          message: first.itemId + ': ' + e.name + ' - ' + e.message
        });
      }
    });

    return summary;
  }

  function updateItemLocationRows(itemRec, locationSet, sourceCost, zeroMissing) {
    const lineCount = safeGetLineCount(itemRec, LOCATION_SUBLIST);
    let updated = 0;

    for (let line = 0; line < lineCount; line += 1) {
      const locationId = clean(safeGetSublistValue(itemRec, LOCATION_SUBLIST, LOCATION_FIELD, line));

      if (!locationId || !locationSet[locationId]) {
        continue;
      }

      const existingCost = safeGetSublistValue(itemRec, LOCATION_SUBLIST, LOCATION_COST_FIELD, line);
      const shouldUpdate = !hasValue(existingCost) || (zeroMissing && toNumber(existingCost) === 0);

      if (!shouldUpdate) {
        continue;
      }

      itemRec.setSublistValue({
        sublistId: LOCATION_SUBLIST,
        fieldId: LOCATION_COST_FIELD,
        line,
        value: sourceCost
      });
      updated += 1;
    }

    return updated;
  }

  function getItemRows(filters) {
    const itemFilters = [
      ['type', 'anyof', filters.itemType ? [filters.itemType] : ['InvtPart', 'Assembly']]
    ];

    if (!filters.includeInactive) {
      itemFilters.push('AND', ['isinactive', 'is', 'F']);
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
        'cost',
        'isinactive'
      ]
    });

    const rows = [];
    const paged = itemSearch.runPaged({ pageSize: PAGE_SIZE });

    paged.pageRanges.forEach((pageRange) => {
      const page = paged.fetch({ index: pageRange.index });

      page.data.forEach((r) => {
        const itemInternalId = safeSearchValue(r, 'internalid') || String(r.id || '');

        if (!itemInternalId) {
          return;
        }

        rows.push({
          itemInternalId,
          itemId: safeSearchValue(r, 'itemid'),
          displayName: safeSearchValue(r, 'displayname'),
          itemTypeValue: safeSearchValue(r, 'type'),
          itemType: safeSearchText(r, 'type') || safeSearchValue(r, 'type'),
          recordType: r.recordType || '',
          costingMethod: safeSearchText(r, 'costingmethod') || safeSearchValue(r, 'costingmethod'),
          sourceCost: clean(safeSearchValue(r, 'cost')),
          isInactive: isTruthy(safeSearchValue(r, 'isinactive')) ? 'Yes' : 'No'
        });
      });
    });

    return rows;
  }

  function getLocationCostMap(items, locations) {
    const out = {};
    const itemIds = items.map((item) => item.itemInternalId);
    const locationIds = locations.map((location) => location.id);

    chunk(itemIds, 900).forEach((ids) => {
      const itemSearch = search.create({
        type: search.Type.ITEM,
        filters: [
          ['internalid', 'anyof', ids],
          'AND',
          ['inventorylocation', 'anyof', locationIds]
        ],
        columns: [
          search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
          search.createColumn({ name: 'inventorylocation', sort: search.Sort.ASC }),
          'cost'
        ]
      });

      forEachPagedResult(itemSearch, (r) => {
        const itemId = safeSearchValue(r, 'internalid') || String(r.id || '');
        const locationId = safeSearchValue(r, 'inventorylocation');

        if (itemId && locationId) {
          const cost = safeSearchValue(r, 'cost');
          out[itemId + '|' + locationId] = {
            cost,
            costText: clean(cost)
          };
        }
      });
    });

    return out;
  }

  function getStandardCostRevalMap(items, locations) {
    const out = {};
    const itemIds = items.map((item) => item.itemInternalId);
    const locationIds = locations.map((location) => location.id);

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
          ['location', 'anyof', locationIds]
        ],
        columns: [
          'item',
          'location',
          'tranid',
          search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
          search.createColumn({ name: 'internalid', sort: search.Sort.DESC })
        ]
      });

      forEachPagedResult(revalSearch, (r) => {
        const itemId = safeSearchValue(r, 'item');
        const locationId = safeSearchValue(r, 'location');
        const key = itemId + '|' + locationId;

        if (itemId && locationId && !out[key]) {
          out[key] = {
            itemId,
            locationId,
            date: safeSearchValue(r, 'trandate'),
            tranId: safeSearchValue(r, 'tranid') || safeSearchValue(r, 'internalid')
          };
        }
      });
    });

    return out;
  }

  function getRequestedLocations(locationText) {
    const tokens = parseTokens(locationText);
    const seenOutput = {};
    const unresolved = [];
    const locationsById = {};
    const locationsByName = {};
    const locations = [];

    const locationSearch = search.create({
      type: search.Type.LOCATION,
      filters: [],
      columns: [
        'internalid',
        search.createColumn({ name: 'name', sort: search.Sort.ASC })
      ]
    });

    forEachPagedResult(locationSearch, (r) => {
      const id = safeSearchValue(r, 'internalid') || String(r.id || '');
      const name = safeSearchValue(r, 'name') || id;

      if (id) {
        locationsById[id] = { id, name };
      }

      if (name) {
        locationsByName[normalizeName(name)] = { id, name };
      }
    });

    tokens.forEach((token) => {
      let location = null;

      if (/^\d+$/.test(token)) {
        location = locationsById[token] || { id: token, name: token };
      } else {
        location = locationsByName[normalizeName(token)] || null;
      }

      if (!location || !location.id) {
        unresolved.push(token);
        return;
      }

      if (!seenOutput[location.id]) {
        seenOutput[location.id] = true;
        locations.push(location);
      }
    });

    return {
      locations,
      unresolved
    };
  }

  function getSelectedLocationIds(locationText) {
    return getRequestedLocations(locationText).locations.map((location) => location.id);
  }

  function getMissingStatus(costRow, standardCostRow, zeroMissing) {
    if (standardCostRow) {
      return '';
    }

    if (!costRow) {
      return 'No standard cost row';
    }

    if (!hasValue(costRow.cost)) {
      return 'No standard cost row';
    }

    if (zeroMissing && toNumber(costRow.cost) === 0) {
      return 'Zero cost';
    }

    return '';
  }

  function buildCsvUrl(filters) {
    try {
      return url.resolveScript({
        scriptId: runtime.getCurrentScript().id,
        deploymentId: runtime.getCurrentScript().deploymentId,
        params: {
          [PARAMS.locations]: filters.locationText,
          [PARAMS.itemType]: filters.itemType,
          [PARAMS.includeInactive]: filters.includeInactive ? 'T' : 'F',
          [PARAMS.onlyStandard]: filters.onlyStandard ? 'T' : 'F',
          [PARAMS.zeroMissing]: filters.zeroMissing ? 'T' : 'F',
          [PARAMS.sourceCostField]: filters.sourceCostField,
          [PARAMS.action]: ACTIONS.report,
          [PARAMS.exportCsv]: 'T'
        }
      });
    } catch (e) {
      return '';
    }
  }

  function writeCsv(response, rows) {
    const header = [
      'Item Internal ID',
      'Item Name/Number',
      'Display Name',
      'Item Type',
      'Costing Method',
      'Source Cost',
      'Location ID',
      'Location',
      'Missing Reason',
      'Current Location Cost'
    ];

    const lines = [header].concat(rows.map((row) => [
      row.itemInternalId,
      row.itemId,
      row.displayName,
      row.itemType,
      row.costingMethod,
      row.sourceCost,
      row.locationId,
      row.locationName,
      row.status,
      row.currentCost
    ]));

    response.addHeader({
      name: 'Content-Type',
      value: 'text/csv; charset=UTF-8'
    });
    response.addHeader({
      name: 'Content-Disposition',
      value: 'attachment; filename="psiq_target_location_item_cost.csv"'
    });
    response.write({
      output: lines.map((line) => line.map(csvCell).join(',')).join('\n')
    });
  }

  function normalizeFilters(params) {
    const script = runtime.getCurrentScript();
    const defaultLocationText = clean(script.getParameter({ name: PARAMS.defaultLocations })) ||
      DEFAULT_TARGET_LOCATIONS.join('\n');
    const action = clean(params[PARAMS.action]);

    return {
      locationText: clean(params[PARAMS.locations]) || defaultLocationText,
      itemType: normalizeItemType(params[PARAMS.itemType]),
      includeInactive: isTruthy(params[PARAMS.includeInactive]),
      onlyStandard: params[PARAMS.onlyStandard] == null ? true : isTruthy(params[PARAMS.onlyStandard]),
      zeroMissing: params[PARAMS.zeroMissing] == null ? true : isTruthy(params[PARAMS.zeroMissing]),
      sourceCostField: clean(params[PARAMS.sourceCostField]) || 'cost',
      action: action === ACTIONS.apply ? ACTIONS.apply : ACTIONS.report,
      exportCsv: isTruthy(params[PARAMS.exportCsv])
    };
  }

  function normalizeItemType(value) {
    const text = clean(value);
    return text === 'InvtPart' || text === 'Assembly' ? text : '';
  }

  function getItemRecordType(row) {
    if (row.recordType) {
      return row.recordType;
    }

    const text = clean(row.itemType).toLowerCase();

    if (text.indexOf('assembly') !== -1) {
      if (text.indexOf('serial') !== -1) return 'serializedassemblyitem';
      if (text.indexOf('lot') !== -1) return 'lotnumberedassemblyitem';
      return 'assemblyitem';
    }

    if (text.indexOf('inventory') !== -1 || row.itemTypeValue === 'InvtPart') {
      if (text.indexOf('serial') !== -1) return 'serializedinventoryitem';
      if (text.indexOf('lot') !== -1) return 'lotnumberedinventoryitem';
      return 'inventoryitem';
    }

    return '';
  }

  function groupRowsByItem(rows) {
    const out = {};

    rows.forEach((row) => {
      if (!out[row.itemInternalId]) {
        out[row.itemInternalId] = [];
      }

      out[row.itemInternalId].push(row);
    });

    return out;
  }

  function setSublistValue(sublist, id, line, value) {
    const text = clean(value);

    if (!text) {
      return;
    }

    sublist.setSublistValue({
      id,
      line,
      value: text.slice(0, 300)
    });
  }

  function parseTokens(value) {
    const seen = {};

    return String(value || '')
      .split(/[\n,;|\u0005]+/)
      .map(clean)
      .filter((token) => {
        const key = normalizeName(token);

        if (!key || seen[key]) {
          return false;
        }

        seen[key] = true;
        return true;
      });
  }

  function isStandardCosting(value) {
    const text = clean(value).toLowerCase();
    return text.indexOf('standard') !== -1 || text === 'std';
  }

  function isValidApplyCost(value) {
    return value != null && !isNaN(value) && value > 0;
  }

  function safeGetValue(rec, fieldId) {
    try {
      const value = rec.getValue({ fieldId });
      return value == null ? '' : value;
    } catch (e) {
      return '';
    }
  }

  function safeGetLineCount(rec, sublistId) {
    try {
      return rec.getLineCount({ sublistId }) || 0;
    } catch (e) {
      return 0;
    }
  }

  function safeGetSublistValue(rec, sublistId, fieldId, line) {
    try {
      const value = rec.getSublistValue({ sublistId, fieldId, line });
      return value == null ? '' : value;
    } catch (e) {
      return '';
    }
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

  function forEachPagedResult(searchObj, callback) {
    const paged = searchObj.runPaged({ pageSize: PAGE_SIZE });

    paged.pageRanges.forEach((pageRange) => {
      const page = paged.fetch({ index: pageRange.index });
      page.data.forEach(callback);
    });
  }

  function csvCell(value) {
    const text = clean(value);
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function hasValue(value) {
    return clean(value) !== '';
  }

  function isTruthy(value) {
    return value === true || value === 'T' || value === 'true' || value === 'Y';
  }

  function toNumber(value) {
    const parsed = parseFloat(String(value || '').replace(/,/g, ''));
    return isNaN(parsed) ? NaN : parsed;
  }

  function normalizeName(value) {
    return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function chunk(values, size) {
    const out = [];

    for (let i = 0; i < values.length; i += size) {
      out.push(values.slice(i, i + size));
    }

    return out;
  }

  function escapeHtml(value) {
    return clean(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function clean(value) {
    return String(value == null ? '' : value).trim();
  }

  return {
    onRequest
  };
});
