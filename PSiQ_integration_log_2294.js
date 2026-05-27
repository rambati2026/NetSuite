/**
 * NetSuite Suitelet: Integration Error Monitoring Dashboard
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati
 * Date : May/11/2026
 */
define(['N/ui/serverWidget', 'N/query', 'N/search', 'N/record', 'N/runtime', 'N/url', 'N/format'], (
  serverWidget,
  query,
  search,
  record,
  runtime,
  url,
  format
) => {
  const CONFIG = {
    // Primary custom record source for XX1S order response records.
    recordType: 'customrecord_xx1s_order_resp',
    fallbackRecordTypes: ['customrecord_xx1s_order_records'],
    recordTypeParameter: 'custscript_xx1s_response_record_type',
    recordTypeUrlParam: 'recordType',

    fields: {
      id: 'internalid',
      name: 'name',
      owner: 'owner',
      created: 'created',
      transactionType: ['custrecord_xx1s_transaction_type'],
      returnMessage: ['custrecord_xx1s_return_message'],
      sanminaOrderNumber: ['custrecord_xx1s_sanmina_order_number'],
      purchaseOrder: ['custrecord_xx1s_purchase_order_number'],
      inactive: 'isinactive'
    },

    drilldownPageSize: 100,
    searchPageSize: 1000,
    queryLimit: 2000,
    defaultFromMonth: 2,
    defaultFromDay: 1,
    dashboardTitle: 'Order Response Integration Monitor',
    developedBy: 'Ramakrishna Ambati',
    version: '1.2.4',
    allowedAccounts: ['5775522', '5775522_SB1', '5775522_SB2'],
    useSearchDateFilters: true,
    useSearchDetailColumns: false,
    enableRetry: true,
    retrySuitelet: {
      script: '1948',
      deploy: '1',
      companyId: '',
      orderIdParam: 'ordID'
    },
    retry: {
      flagFields: [
        'custrecord_xx1s_retry_requested',
        'custrecord_xx1s_retry',
        'custrecord_xx1s_reprocess_requested',
        'custrecord_xx1s_reprocess',
        'custrecord_retry_requested',
        'custrecord_retry',
        'custrecord_reprocess_requested',
        'custrecord_reprocess',
        'custrecord_to_be_retried'
      ],
      dateFields: [
        'custrecord_xx1s_retry_requested_at',
        'custrecord_xx1s_retry_date',
        'custrecord_retry_requested_at',
        'custrecord_retry_date'
      ],
      statusFields: [
        'custrecord_xx1s_retry_status',
        'custrecord_retry_status',
        'custrecord_xx1s_status',
        'custrecord_processing_status'
      ],
      noteFields: [
        'custrecord_xx1s_retry_note',
        'custrecord_xx1s_retry_message',
        'custrecord_retry_note',
        'custrecord_retry_message'
      ]
    }
  };
  const transactionInternalIdCache = {};

  function onRequest(context) {
    assertAllowedAccount();

    const request = context.request;
    const response = context.response;
    const action = request.parameters.action || 'dashboard';

    if (action === 'data') {
      response.setHeader({ name: 'Content-Type', value: 'application/json' });
      try {
        response.write(JSON.stringify(getDashboardData(request.parameters)));
      } catch (e) {
        log.error({ title: 'Integration dashboard data failed', details: e });
        response.write(JSON.stringify(buildErrorData(e, request.parameters)));
      }
      return;
    }

    if (action === 'retry') {
      response.setHeader({ name: 'Content-Type', value: 'application/json' });
      response.write(JSON.stringify(handleRetry(request.parameters.id, request.parameters.recordType)));
      return;
    }

    renderDashboard(request, response);
  }

  function assertAllowedAccount() {
    const allowedAccounts = CONFIG.allowedAccounts || [];

    if (allowedAccounts.length && allowedAccounts.indexOf(runtime.accountId) < 0) {
      throw Error('Unauthorized account');
    }
  }

  function renderDashboard(request, response) {
    const form = serverWidget.createForm({ title: CONFIG.dashboardTitle });
    const htmlField = form.addField({
      id: 'custpage_dashboard_html',
      label: 'Dashboard',
      type: serverWidget.FieldType.INLINEHTML
    });

    const suiteletUrl = url.resolveScript({
      scriptId: runtime.getCurrentScript().id,
      deploymentId: runtime.getCurrentScript().deploymentId,
      returnExternalUrl: false
    });

    let data;
    try {
      data = getDashboardData(request.parameters || {});
    } catch (e) {
      log.error({ title: 'Integration dashboard render failed', details: e });
      data = buildErrorData(e, request.parameters || {});
    }

    htmlField.defaultValue = buildHtml(suiteletUrl, data);
    response.writePage(form);
  }

  function getDashboardData(params) {
    const filters = normalizeDashboardFilters(params || {});
    const recordTypeInfo = getConfiguredRecordTypeInfo(params || {});

    if (!recordTypeInfo.recordType) {
      return buildConfigData(recordTypeInfo.message, filters, recordTypeInfo.rawRecordType, discoverRecordTypeCandidates());
    }

    let rows;
    let selectedRecordType = recordTypeInfo.recordType;

    try {
      rows = fetchRows(filters, selectedRecordType);

      if (!rows.length || !rowsHaveResponseDetails(rows)) {
        const fallbackRecordType = findFallbackRecordTypeWithRows(filters, selectedRecordType);

        if (fallbackRecordType) {
          selectedRecordType = fallbackRecordType.recordType;
          rows = fallbackRecordType.rows;
        }
      }
    } catch (e) {
      const fallbackRecordType = findFallbackRecordTypeWithRows(filters, selectedRecordType);

      if (fallbackRecordType) {
        selectedRecordType = fallbackRecordType.recordType;
        rows = fallbackRecordType.rows;
      } else if (isInvalidRecordTypeError(e)) {
        return buildConfigData(
          'Invalid custom record type: ' + recordTypeInfo.recordType + '. Open the custom record type in NetSuite and use its exact Internal ID, then set CONFIG.recordType or deployment parameter ' + CONFIG.recordTypeParameter + '.',
          filters,
          recordTypeInfo.recordType,
          discoverRecordTypeCandidates()
        );
      }

      if (!rows) {
        throw e;
      }
    }

    const searchStats = rows.searchStats || buildEmptySearchStats();
    const normalized = rows.map(row => normalizeRow(row, selectedRecordType));
    const viewRows = applyResultFilters(buildViewRows(normalized, filters.viewMode), filters);
    const drilldownRows = buildViewDrilldownRows(viewRows, filters.viewMode);
    const summary = buildSummary(viewRows);
    const previousPeriod = fetchPreviousPeriodSummary(filters, selectedRecordType);
    summary.comparison = buildSummaryComparison(summary, previousPeriod.summary, previousPeriod.filters);

    return {
      generatedAt: new Date().toISOString(),
      recordType: selectedRecordType,
      filters,
      searchStats,
      summary,
      insights: buildInsights(viewRows),
      categoryBreakdown: buildCategoryBreakdown(viewRows),
      failureFingerprints: buildFailureFingerprints(viewRows),
      latestFailures: buildLatestFailures(viewRows),
      dailyTrend: buildDailyTrend(viewRows, filters),
      topVendors: buildTopVendors(viewRows),
      drilldownRows,
      rows: viewRows
    };
  }

  function rowsHaveResponseDetails(rows) {
    return (rows || []).some(r => {
      return r.transaction_type ||
        r.return_message ||
        r.sanmina_order_number ||
        r.purchase_order;
    });
  }

  function findFallbackRecordTypeWithRows(filters, currentRecordType) {
    const fallbackRecordTypes = CONFIG.fallbackRecordTypes || [];

    for (let i = 0; i < fallbackRecordTypes.length; i++) {
      const recordType = String(fallbackRecordTypes[i] || '').toLowerCase();

      if (!recordType || recordType === currentRecordType) continue;

      try {
        const rows = fetchRows(filters, recordType);

        if (rows.length && rowsHaveResponseDetails(rows)) {
          return {
            recordType,
            rows
          };
        }
      } catch (e) {
        log.error({
          title: 'Fallback integration record source failed: ' + recordType,
          details: e
        });
      }
    }

    return null;
  }

  function buildConfigData(message, filters, recordType, candidates) {
    return {
      generatedAt: new Date().toISOString(),
      error: message,
      recordType: recordType || '',
      candidates: candidates || [],
      filters,
      summary: {
        total: 0,
        success: 0,
        failed: 0,
        unknown: 0,
        successRate: 0,
        failureRate: 0,
        topCategory: 'None'
      },
      insights: buildInsights([]),
      searchStats: buildEmptySearchStats(),
      categoryBreakdown: [],
      failureFingerprints: [],
      latestFailures: [],
      dailyTrend: buildDailyTrend([], filters),
      topVendors: [],
      drilldownRows: [],
      rows: []
    };
  }

  function buildErrorData(error, params) {
    const filters = normalizeDashboardFilters(params || {});

    return {
      generatedAt: new Date().toISOString(),
      error: error && error.message ? error.message : String(error),
      recordType: getConfiguredRecordTypeInfo(params || {}).recordType,
      candidates: discoverRecordTypeCandidates(),
      filters,
      summary: {
        total: 0,
        success: 0,
        failed: 0,
        unknown: 0,
        successRate: 0,
        failureRate: 0,
        topCategory: 'None'
      },
      insights: buildInsights([]),
      searchStats: buildEmptySearchStats(),
      categoryBreakdown: [],
      failureFingerprints: [],
      latestFailures: [],
      dailyTrend: buildDailyTrend([], filters),
      topVendors: [],
      drilldownRows: [],
      rows: []
    };
  }

  function getConfiguredRecordTypeInfo(params) {
    let rawRecordType = '';
    params = params || {};

    try {
      rawRecordType = runtime.getCurrentScript().getParameter({
        name: CONFIG.recordTypeParameter
      }) || '';
    } catch (e) {
      rawRecordType = '';
    }

    rawRecordType = String(CONFIG.recordType || rawRecordType || params[CONFIG.recordTypeUrlParam] || '').trim();

    if (!rawRecordType) {
      return {
        rawRecordType: '',
        recordType: '',
        message: 'Missing response custom record type. Set CONFIG.recordType in this script, or add deployment parameter ' + CONFIG.recordTypeParameter + ' with the actual custom record Internal ID.'
      };
    }

    const recordType = rawRecordType.toLowerCase();
    if (!/^[a-z][a-z0-9_]*$/.test(recordType)) {
      return {
        rawRecordType,
        recordType: '',
        message: 'Invalid response custom record type value: ' + rawRecordType + '. Use only the NetSuite script/internal ID, for example customrecord_your_record_id.'
      };
    }

    return {
      rawRecordType,
      recordType,
      message: ''
    };
  }

  function discoverRecordTypeCandidates() {
    const queries = [
      "SELECT scriptid, name FROM customrecordtype WHERE isinactive = 'F' ORDER BY name",
      'SELECT scriptid, name FROM customrecordtype ORDER BY name',
      "SELECT scriptid, name FROM CustomRecordType WHERE isinactive = 'F' ORDER BY name",
      'SELECT scriptid, name FROM CustomRecordType ORDER BY name'
    ];

    for (let i = 0; i < queries.length; i++) {
      try {
        const rows = query.runSuiteQL({ query: queries[i] }).asMappedResults();
        return rankRecordTypeCandidates(rows);
      } catch (e) {
        // Try the next metadata table/query shape.
      }
    }

    return [];
  }

  function rankRecordTypeCandidates(rows) {
    const terms = ['xx1s', 'order', 'response', 'integration', 'sanmina'];

    return (rows || []).map(r => {
      const scriptId = String(r.scriptid || r.scriptId || r.SCRIPTID || '').toLowerCase();
      const name = String(r.name || r.NAME || '').toLowerCase();
      const haystack = scriptId + ' ' + name;
      const score = terms.reduce((sum, term) => sum + (haystack.indexOf(term) >= 0 ? 1 : 0), 0);

      return {
        scriptid: scriptId,
        name: r.name || r.NAME || '',
        score
      };
    }).filter(r => r.scriptid && r.scriptid.indexOf('customrecord') === 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 12);
  }

  function normalizeDashboardFilters(params) {
    const defaults = getDefaultDateRange();

    return {
      dateFrom: isIsoDate(params.dateFrom) ? params.dateFrom : defaults.dateFrom,
      dateTo: isIsoDate(params.dateTo) ? params.dateTo : defaults.dateTo,
      viewMode: normalizeViewMode(params.viewMode || params.mode),
      status: params.status || 'ALL',
      category: params.category || 'ALL',
      search: String(params.search || '').trim()
    };
  }

  function normalizeViewMode(value) {
    return String(value || '').toUpperCase() === 'HISTORY' ? 'HISTORY' : 'CURRENT';
  }

  function getDefaultDateRange() {
    const today = new Date();
    const to = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const from = new Date(to.getFullYear(), Number(CONFIG.defaultFromMonth || 2) - 1, Number(CONFIG.defaultFromDay || 1));

    if (from > to) {
      from.setFullYear(from.getFullYear() - 1);
    }

    return {
      dateFrom: toIsoDate(from),
      dateTo: toIsoDate(to)
    };
  }

  function fetchRows(filters, recordType) {
    const fromDate = isoDateBoundary(filters.dateFrom, false);
    const toDate = isoDateBoundary(filters.dateTo, true);
    const rows = fetchRowsFromSearch(recordType, fromDate, toDate);
    const searchStats = rows.searchStats || buildEmptySearchStats();

    rows.searchStats = Object.assign({}, searchStats, {
      matchedRows: rows.length,
      returnedRows: rows.length
    });

    return rows;
  }

  function applyResultFilters(rows, filters) {
    let filteredRows = (rows || []).slice();

    if (filters.status && filters.status !== 'ALL') {
      filteredRows = filteredRows.filter(r => r.status === filters.status);
    }

    if (filters.category && filters.category !== 'ALL') {
      filteredRows = filteredRows.filter(r => r.category === filters.category);
    }

    if (filters.search) {
      const s = String(filters.search || '').toLowerCase();
      filteredRows = filteredRows.filter(r => buildNormalizedRowSearchText(r).indexOf(s) >= 0);
    }

    return filteredRows;
  }

  function buildNormalizedRowSearchText(row) {
    return [
      row.id,
      row.name,
      row.owner,
      row.created,
      row.transactionType,
      row.status,
      row.category,
      row.severity,
      row.priority,
      row.failureFingerprint,
      row.returnMessage,
      row.sanminaOrderNumber,
      row.purchaseOrderId,
      row.purchaseOrder
    ].join(' ').toLowerCase();
  }

  function fetchRowsFromSearch(recordType, fromDate, toDate) {
    const includeDetailColumns = !!CONFIG.useSearchDetailColumns;

    try {
      return fetchRowsFromSearchInternal(recordType, fromDate, toDate, includeDetailColumns, !!CONFIG.useSearchDateFilters);
    } catch (e) {
      if (includeDetailColumns) {
        log.error({
          title: 'Integration response detail column search failed; falling back to record.load()',
          details: e
        });

        try {
          return fetchRowsFromSearchInternal(recordType, fromDate, toDate, false, !!CONFIG.useSearchDateFilters);
        } catch (dateFilterError) {
          log.error({
            title: 'Integration response date-filtered search failed; falling back to post-filtering',
            details: dateFilterError
          });

          return fetchRowsFromSearchInternal(recordType, fromDate, toDate, false, false);
        }
      }

      log.error({
        title: 'Integration response date-filtered search failed; falling back to post-filtering',
        details: e
      });

      return fetchRowsFromSearchInternal(recordType, fromDate, toDate, false, false);
    }
  }

  function fetchRowsFromSearchInternal(recordType, fromDate, toDate, includeDetailColumns, useDateFilters) {
    const f = CONFIG.fields;
    const colId = search.createColumn({ name: f.id, sort: search.Sort.DESC });
    const colName = search.createColumn({ name: f.name });
    const colCreated = search.createColumn({ name: f.created });
    const detailColumns = includeDetailColumns ? buildResponseSearchDetailColumns() : [];
    const searchColumns = [colId, colName, colCreated].concat(flattenDetailColumns(detailColumns));
    const rows = [];
    let scanned = 0;

    const responseSearch = search.create({
      type: recordType,
      filters: buildResponseSearchFilters(fromDate, toDate, useDateFilters),
      columns: searchColumns
    });

    const completed = runPagedSearch(responseSearch, result => {
      scanned += 1;
      processResponseSearchResult({
        result,
        recordType,
        fromDate,
        toDate,
        includeDetailColumns,
        detailColumns,
        useDateFilters,
        colId,
        colName,
        colCreated,
        rows
      });

      return scanned < CONFIG.queryLimit;
    });

    rows.searchStats = {
      scanned,
      queryLimit: CONFIG.queryLimit,
      hitQueryLimit: completed === false && scanned >= Number(CONFIG.queryLimit || 0),
      useDateFilters,
      includeDetailColumns
    };

    return rows;
  }

  function buildResponseSearchFilters(fromDate, toDate, useDateFilters) {
    const f = CONFIG.fields;
    const filters = [[f.inactive, 'is', 'F']];

    if (useDateFilters) {
      filters.push(
        'AND',
        [f.created, 'onorafter', formatSearchDate(fromDate)],
        'AND',
        [f.created, 'onorbefore', formatSearchDate(toDate)]
      );
    }

    return filters;
  }

  function processResponseSearchResult(options) {
    const result = options.result;
    const id = result.getValue(options.colId);
    const created = result.getValue(options.colCreated);
    const createdDate = parseNsDateTime(created);

    if (!options.useDateFilters && (!createdDate || createdDate < options.fromDate || createdDate > options.toDate)) {
      return;
    }

    let responseValues = options.includeDetailColumns ? readResponseSearchDetailValues(result, options.detailColumns) : {};

    if (!rowsHaveResponseDetails([responseValues])) {
      responseValues = loadResponseRecordValues(options.recordType, id);
    }

    options.rows.push(Object.assign({
      id,
      name: result.getValue(options.colName) || '',
      owner: '',
      created,
      isinactive: 'F'
    }, responseValues));
  }

  function runPagedSearch(responseSearch, eachResult) {
    const pagedData = responseSearch.runPaged({
      pageSize: getSearchPageSize()
    });

    for (let i = 0; i < pagedData.pageRanges.length; i++) {
      const page = pagedData.fetch({ index: pagedData.pageRanges[i].index });

      for (let j = 0; j < page.data.length; j++) {
        if (eachResult(page.data[j]) === false) {
          return false;
        }
      }
    }

    return true;
  }

  function getSearchPageSize() {
    const configuredPageSize = Number(CONFIG.searchPageSize || 1000);
    return Math.max(5, Math.min(1000, configuredPageSize));
  }

  function formatSearchDate(dateObj) {
    try {
      return format.format({
        value: dateObj,
        type: format.Type.DATE
      });
    } catch (e) {
      return toIsoDate(dateObj);
    }
  }

  function buildResponseSearchDetailColumns() {
    const f = CONFIG.fields;
    return [
      { key: 'owner', fieldIds: normalizeFieldIdList(f.owner) },
      { key: 'transaction_type', fieldIds: normalizeFieldIdList(f.transactionType) },
      { key: 'return_message', fieldIds: normalizeFieldIdList(f.returnMessage) },
      { key: 'sanmina_order_number', fieldIds: normalizeFieldIdList(f.sanminaOrderNumber) },
      { key: 'purchase_order', fieldIds: normalizeFieldIdList(f.purchaseOrder) }
    ].map(def => {
      return {
        key: def.key,
        columns: def.fieldIds.map(fieldId => search.createColumn({ name: fieldId }))
      };
    });
  }

  function flattenDetailColumns(detailColumns) {
    return detailColumns.reduce((cols, def) => cols.concat(def.columns), []);
  }

  function readResponseSearchDetailValues(result, detailColumns) {
    const values = {};

    detailColumns.forEach(def => {
      values[def.key] = readFirstSearchColumnValue(result, def.columns);

      if (def.key === 'purchase_order') {
        values.purchase_order_id = readFirstSearchColumnRawValue(result, def.columns);
      }
    });

    return values;
  }

  function readFirstSearchColumnValue(result, columns) {
    for (let i = 0; i < columns.length; i++) {
      try {
        const text = result.getText(columns[i]);

        if (text) return String(text);
      } catch (e) {
        // Some search columns do not expose text values.
      }

      try {
        const value = result.getValue(columns[i]);

        if (value !== null && value !== undefined && value !== '') {
          return String(value);
        }
      } catch (e) {
        // Try the next configured field id.
      }
    }

    return '';
  }

  function readFirstSearchColumnRawValue(result, columns) {
    for (let i = 0; i < columns.length; i++) {
      try {
        const value = result.getValue(columns[i]);

        if (value !== null && value !== undefined && value !== '') {
          return String(value);
        }
      } catch (e) {
        // Try the next configured field id.
      }
    }

    return '';
  }

  function normalizeFieldIdList(fieldIds) {
    return (Array.isArray(fieldIds) ? fieldIds : [fieldIds]).filter(Boolean);
  }

  function loadResponseRecordValues(recordType, id) {
    const f = CONFIG.fields;

    try {
      const responseRecord = record.load({
        type: recordType,
        id,
        isDynamic: false
      });
      const configuredValues = {
        owner: safeRecordValue(responseRecord, f.owner),
        transaction_type: safeRecordValue(responseRecord, f.transactionType),
        return_message: safeRecordValue(responseRecord, f.returnMessage),
        sanmina_order_number: safeRecordValue(responseRecord, f.sanminaOrderNumber),
        purchase_order: safeRecordValue(responseRecord, f.purchaseOrder),
        purchase_order_id: safeRecordRawValue(responseRecord, f.purchaseOrder)
      };
      const detectedValues = needsResponseAutoDetection(configuredValues) ?
        detectResponseRecordValues(responseRecord) :
        buildEmptyDetectedResponseValues();

      return {
        owner: configuredValues.owner || detectedValues.owner,
        transaction_type: configuredValues.transaction_type || detectedValues.transaction_type,
        return_message: configuredValues.return_message || detectedValues.return_message,
        sanmina_order_number: configuredValues.sanmina_order_number || detectedValues.sanmina_order_number,
        purchase_order: configuredValues.purchase_order || detectedValues.purchase_order,
        purchase_order_id: configuredValues.purchase_order_id
      };
    } catch (e) {
      log.error({
        title: 'Failed to load integration response record ' + id,
        details: e
      });
    }

    return {
      owner: '',
      transaction_type: '',
      return_message: '',
      sanmina_order_number: '',
      purchase_order: '',
      purchase_order_id: ''
    };
  }

  function needsResponseAutoDetection(configuredValues) {
    return !configuredValues.transaction_type ||
      !configuredValues.return_message ||
      !configuredValues.sanmina_order_number ||
      !configuredValues.purchase_order;
  }

  function buildEmptyDetectedResponseValues() {
    return {
      owner: '',
      transaction_type: '',
      return_message: '',
      sanmina_order_number: '',
      purchase_order: '',
      purchase_order_id: ''
    };
  }

  function detectResponseRecordValues(responseRecord) {
    const candidates = buildFieldCandidates(responseRecord);

    return {
      owner: findCandidateValue(candidates, [
        c => hasFieldToken(c, 'owner')
      ]),
      transaction_type: findCandidateValue(candidates, [
        c => hasFieldTokens(c, ['transaction', 'type'])
      ]),
      return_message: findCandidateValue(candidates, [
        c => hasFieldTokens(c, ['return', 'message']),
        c => hasFieldToken(c, 'message') && looksLikeResponseMessage(c.value),
        c => looksLikeResponseMessage(c.value)
      ]),
      sanmina_order_number: findCandidateValue(candidates, [
        c => hasFieldTokens(c, ['sanmina', 'order'])
      ]),
      purchase_order: findCandidateValue(candidates, [
        c => hasFieldTokens(c, ['purchase', 'order']),
        c => hasFieldToken(c, 'po') && hasFieldToken(c, 'number'),
        c => looksLikeOrderReference(c.value)
      ])
    };
  }

  function buildFieldCandidates(responseRecord) {
    let fieldIds = [];

    try {
      fieldIds = responseRecord.getFields() || [];
    } catch (e) {
      fieldIds = [];
    }

    return fieldIds.map(fieldId => {
      const label = getRecordFieldLabel(responseRecord, fieldId);
      const value = safeRecordValue(responseRecord, fieldId);

      return {
        fieldId,
        label,
        value,
        matchText: normalizeMatchText(fieldId + ' ' + label)
      };
    }).filter(c => c.value !== '');
  }

  function getRecordFieldLabel(responseRecord, fieldId) {
    try {
      const field = responseRecord.getField({ fieldId });
      return field && field.label ? String(field.label) : '';
    } catch (e) {
      return '';
    }
  }

  function findCandidateValue(candidates, tests) {
    for (let i = 0; i < tests.length; i++) {
      const match = candidates.find(tests[i]);

      if (match && match.value !== '') {
        return match.value;
      }
    }

    return '';
  }

  function hasFieldToken(candidate, token) {
    return candidate.matchText.indexOf(normalizeMatchText(token)) >= 0;
  }

  function hasFieldTokens(candidate, tokens) {
    return tokens.every(token => hasFieldToken(candidate, token));
  }

  function looksLikeResponseMessage(value) {
    const text = normalizeMatchText(value);
    return text.indexOf('error message') >= 0 ||
      text.indexOf('status: success') >= 0 ||
      text.indexOf('new_order_number') >= 0 ||
      text.indexOf('missing xref') >= 0 ||
      text.indexOf('uom conversion') >= 0 ||
      text.indexOf('not on price list') >= 0;
  }

  function looksLikeOrderReference(value) {
    const text = normalizeMatchText(value);
    return text.indexOf('transfer order #') >= 0 ||
      text.indexOf('purchase order #') >= 0 ||
      /^to\d+$/i.test(String(value || '').trim()) ||
      /^po\d+$/i.test(String(value || '').trim());
  }

  function safeRecordValue(responseRecord, fieldIds) {
    const ids = Array.isArray(fieldIds) ? fieldIds : [fieldIds];

    for (let i = 0; i < ids.length; i++) {
      const fieldId = ids[i];

      if (!fieldId) continue;

      try {
        const text = responseRecord.getText({ fieldId });

        if (text) {
          return String(text);
        }
      } catch (e) {
        // Some field types do not support getText; try getValue below.
      }

      try {
        const value = responseRecord.getValue({ fieldId });

        if (value !== null && value !== undefined && value !== '') {
          return String(value);
        }
      } catch (e) {
        // Try the next configured field id.
      }
    }

    return '';
  }

  function safeRecordRawValue(responseRecord, fieldIds) {
    const ids = Array.isArray(fieldIds) ? fieldIds : [fieldIds];

    for (let i = 0; i < ids.length; i++) {
      const fieldId = ids[i];

      if (!fieldId) continue;

      try {
        const value = responseRecord.getValue({ fieldId });

        if (value !== null && value !== undefined && value !== '') {
          return String(value);
        }
      } catch (e) {
        // Try the next configured field id.
      }
    }

    return '';
  }

  function isInvalidRecordTypeError(error) {
    const name = String(error && error.name ? error.name : '');
    const message = String(error && error.message ? error.message : error);
    return name === 'INVALID_SEARCH_TYPE' || message.indexOf('Invalid search type') >= 0;
  }

  function normalizeRow(row, recordType) {
    const status = inferStatus(row.return_message);
    const category = inferCategory(row.return_message);
    const severity = inferSeverity(category, row.return_message, status);
    const priority = inferPriority(severity);
    const failureFingerprint = status === 'FAILED' ? buildFailureFingerprint(row.return_message, category) : '';
    const purchaseOrderId = status === 'FAILED' ?
      resolveRetryOrderInternalId(row) :
      normalizeInternalId(row.purchase_order_id || row.purchase_order);
    const retryUrl = status === 'FAILED' ? buildOrderRetryUrl(purchaseOrderId) : '';

    return {
      id: row.id,
      name: row.name || '',
      recordUrl: buildRecordUrl(recordType, row.id),
      created: row.created || '',
      createdKey: getCreatedDateKey(row.created),
      owner: row.owner || '',
      transactionType: row.transaction_type || '',
      status,
      category,
      severity,
      priority,
      failureFingerprint,
      failureFingerprintKey: failureFingerprint ? normalizeFingerprintKey(failureFingerprint) : '',
      returnMessage: row.return_message || '',
      sanminaOrderNumber: row.sanmina_order_number || '',
      purchaseOrder: row.purchase_order || '',
      purchaseOrderId,
      retryUrl,
      resolvedBySuccess: false,
      retryable: status === 'FAILED'
    };
  }

  function buildRecordUrl(recordType, id) {
    if (!recordType || !id) return '';

    try {
      return url.resolveRecord({
        recordType,
        recordId: id,
        isEditMode: false
      }) || '';
    } catch (e) {
      return '';
    }
  }

  function inferStatus(message) {
    const msg = String(message || '').toUpperCase();
    if (msg.indexOf('ERROR') >= 0 || msg.indexOf('FAILED') >= 0 || msg.indexOf('FAILURE') >= 0 || msg.indexOf('EXCEPTION') >= 0) return 'FAILED';
    if (msg.indexOf('STATUS: SUCCESS') >= 0 || msg.indexOf('SUCCESS') >= 0 || msg.indexOf('SUCCESSFUL') >= 0) return 'SUCCESS';
    return 'UNKNOWN';
  }

  function inferCategory(message) {
    const msg = String(message || '').toUpperCase();
    if (msg.indexOf('ITEM NOT ON PRICE LIST') >= 0) return 'PRICE_LIST';
    if (msg.indexOf('MISSING XREF') >= 0 || msg.indexOf('MISSING ITEM ASSIGNMENT') >= 0) return 'ITEM_XREF';
    if (msg.indexOf('UOM CONVERSION') >= 0) return 'UOM_CONVERSION';
    if (msg.indexOf('VALIDATION FAILED') >= 0 || msg.indexOf('VALIDATION') >= 0) return 'VALIDATION';
    if (msg.indexOf('ORDER TYPE') >= 0) return 'ORDER_TYPE';
    if (msg.indexOf('SUCCESS') >= 0) return 'SUCCESS';
    if (msg.indexOf('ERROR') >= 0 || msg.indexOf('FAILED') >= 0) return 'OTHER_ERROR';
    return 'UNKNOWN';
  }

  function inferSeverity(category, message, status) {
    const msg = String(message || '').toUpperCase();

    if (status === 'SUCCESS') return 'Info';
    if (msg.indexOf('EXCEPTION') >= 0 || msg.indexOf('UNEXPECTED ERROR') >= 0) return 'Critical';
    if (category === 'PRICE_LIST' || category === 'ITEM_XREF') return 'High';
    if (category === 'UOM_CONVERSION' || category === 'VALIDATION' || category === 'ORDER_TYPE') return 'Medium';
    if (category === 'OTHER_ERROR') return 'Medium';
    return 'Low';
  }

  function inferPriority(severity) {
    const priorities = {
      Critical: 'P1',
      High: 'P2',
      Medium: 'P3',
      Low: 'P4',
      Info: 'P4'
    };

    return priorities[severity] || 'P4';
  }

  function buildFailureFingerprint(message, category) {
    const matchText = normalizeMatchText(message);

    if (matchText.indexOf('item not on price list') >= 0) return 'Item not on price list';
    if (matchText.indexOf('missing xref') >= 0 || matchText.indexOf('missing item assignment') >= 0) return 'Missing item cross reference';
    if (matchText.indexOf('uom conversion') >= 0) return 'UOM conversion setup missing';
    if (matchText.indexOf('validation failed') >= 0 || matchText.indexOf('validation') >= 0) return 'Validation failed';
    if (matchText.indexOf('order type') >= 0) return 'Order type issue';

    const cleaned = String(message || '')
      .replace(/^error message\s*[:~\-\s]*/i, '')
      .replace(/^message\s*[:~\-\s]*/i, '')
      .replace(/\b(TO|PO|SO|WO)\s*#?\s*\d+\b/gi, '$1 #')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'date')
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, 'date')
      .replace(/\b\d+\b/g, '#')
      .replace(/\s+/g, ' ')
      .trim();

    return truncateText(formatFingerprintLabel(cleaned || formatCategoryName(category)), 78);
  }

  function formatFingerprintLabel(value) {
    const text = String(value || '').trim();
    if (!text) return 'Unclassified failure';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function normalizeFingerprintKey(value) {
    return normalizeMatchText(value).replace(/\b\d+\b/g, '#');
  }

  function buildSummary(rows) {
    const total = rows.length;
    const success = rows.filter(r => r.status === 'SUCCESS').length;
    const failed = rows.filter(r => r.status === 'FAILED').length;
    const unknown = rows.filter(r => r.status === 'UNKNOWN').length;
    const categories = buildCategoryBreakdown(rows);

    return {
      total,
      success,
      failed,
      unknown,
      successRate: total ? Math.round((success / total) * 1000) / 10 : 0,
      failureRate: total ? Math.round((failed / total) * 1000) / 10 : 0,
      topCategory: categories.length ? categories[0].category : 'None'
    };
  }

  function fetchPreviousPeriodSummary(filters, recordType) {
    const previousFilters = buildPreviousPeriodFilters(filters);

    try {
      const previousRows = applyResultFilters(
        buildViewRows(fetchRows(previousFilters, recordType)
          .map(row => normalizeRow(row, recordType)), previousFilters.viewMode),
        previousFilters
      );

      return {
        filters: previousFilters,
        summary: buildSummary(previousRows)
      };
    } catch (e) {
      log.error({
        title: 'Previous period integration dashboard summary failed',
        details: e
      });
    }

    return {
      filters: previousFilters,
      summary: buildSummary([])
    };
  }

  function buildPreviousPeriodFilters(filters) {
    const start = isoDateBoundary(filters.dateFrom, false);
    const end = isoDateBoundary(filters.dateTo, false);
    const days = getDateRangeDays(start, end);
    const previousTo = new Date(start);
    previousTo.setDate(start.getDate() - 1);

    const previousFrom = new Date(previousTo);
    previousFrom.setDate(previousTo.getDate() - days + 1);

    return Object.assign({}, filters, {
      dateFrom: toIsoDate(previousFrom),
      dateTo: toIsoDate(previousTo)
    });
  }

  function buildSummaryComparison(currentSummary, previousSummary, previousFilters) {
    return {
      previousDateFrom: previousFilters.dateFrom,
      previousDateTo: previousFilters.dateTo,
      total: buildComparisonValue(currentSummary.total, previousSummary.total, false),
      success: buildComparisonValue(currentSummary.success, previousSummary.success, false),
      failed: buildComparisonValue(currentSummary.failed, previousSummary.failed, false),
      unknown: buildComparisonValue(currentSummary.unknown, previousSummary.unknown, false),
      successRate: buildComparisonValue(currentSummary.successRate, previousSummary.successRate, true),
      failureRate: buildComparisonValue(currentSummary.failureRate, previousSummary.failureRate, true),
      topCategory: previousSummary.topCategory || 'None'
    };
  }

  function buildComparisonValue(currentValue, previousValue, isPercent) {
    const current = Number(currentValue || 0);
    const previous = Number(previousValue || 0);
    const delta = isPercent ? Math.round((current - previous) * 10) / 10 : current - previous;

    return {
      previous,
      delta,
      isPercent
    };
  }

  function buildEmptySearchStats() {
    return {
      scanned: 0,
      matchedRows: 0,
      returnedRows: 0,
      queryLimit: CONFIG.queryLimit,
      hitQueryLimit: false,
      useDateFilters: !!CONFIG.useSearchDateFilters,
      includeDetailColumns: !!CONFIG.useSearchDetailColumns
    };
  }

  function buildInsights(rows) {
    const failedRows = rows.filter(r => r.status === 'FAILED');
    const latestFailure = getLatestRow(failedRows);
    const categoryBreakdown = buildCategoryBreakdown(rows);
    const topFailureCategory = categoryBreakdown[0] || { category: 'None', count: 0 };
    const topFailingPo = getTopGroupedValue(failedRows, r => r.purchaseOrder || r.sanminaOrderNumber || 'No PO / TO');
    const failuresLast24Hours = countFailuresSince(failedRows, new Date(new Date().getTime() - (24 * 60 * 60 * 1000)));

    return {
      latestFailure: latestFailure ? latestFailure.name || latestFailure.id : 'None',
      latestFailureDetail: latestFailure ? formatCategoryName(latestFailure.category) + ' · ' + latestFailure.created : '',
      topFailureCategory: topFailureCategory.category,
      topFailureCount: topFailureCategory.count,
      topFailingPo: topFailingPo.name,
      topFailingPoCount: topFailingPo.count,
      failuresLast24Hours,
      retryMode: CONFIG.enableRetry ? 'Enabled' : 'Disabled'
    };
  }

  function getLatestRow(rows) {
    return rows.slice().sort(compareRowsNewestFirst)[0] || null;
  }

  function buildLatestFailures(rows) {
    return rows.filter(r => r.status === 'FAILED')
      .sort(compareRowsNewestFirst)
      .slice(0, 5);
  }

  function buildLatestUniqueDrilldownRows(rows) {
    const map = {};

    (rows || []).forEach(row => {
      const key = buildDrilldownUniqueKey(row);
      const existing = map[key];

      if (!existing || compareRowsNewestFirst(row, existing) < 0) {
        map[key] = row;
      }
    });

    return Object.keys(map)
      .map(key => map[key])
      .sort(compareRowsNewestFirst);
  }

  function buildViewRows(rows, viewMode) {
    if (viewMode === 'HISTORY') return buildHistoryRows(rows);
    return buildCurrentTransactionRows(rows);
  }

  function buildViewDrilldownRows(rows, viewMode) {
    if (viewMode === 'HISTORY') return rows.slice().sort(compareRowsNewestFirst);
    return buildLatestUniqueDrilldownRows(rows);
  }

  function buildHistoryRows(rows) {
    const latestSuccessByTransaction = {};

    (rows || []).forEach(row => {
      if (row.status !== 'SUCCESS') return;

      const key = buildCurrentTransactionKey(row);
      const existing = latestSuccessByTransaction[key];

      if (!existing || compareRowsNewestFirst(row, existing) < 0) {
        latestSuccessByTransaction[key] = row;
      }
    });

    return (rows || []).map(row => {
      const key = buildCurrentTransactionKey(row);
      const latestSuccess = latestSuccessByTransaction[key];
      const resolvedBySuccess = row.status === 'FAILED' &&
        latestSuccess &&
        compareRowsNewestFirst(latestSuccess, row) < 0;

      return Object.assign({}, row, {
        resolvedBySuccess,
        retryable: row.retryable && !resolvedBySuccess
      });
    }).sort(compareRowsNewestFirst);
  }

  function buildCurrentTransactionRows(rows) {
    const map = {};

    (rows || []).forEach(row => {
      const key = buildCurrentTransactionKey(row);
      const existing = map[key];

      if (!existing || compareRowsNewestFirst(row, existing) < 0) {
        map[key] = row;
      }
    });

    return Object.keys(map)
      .map(key => map[key])
      .sort(compareRowsNewestFirst);
  }

  function buildCurrentTransactionKey(row) {
    const candidates = [
      row.purchaseOrder,
      row.name,
      row.transactionType,
      row.sanminaOrderNumber
    ];

    for (let i = 0; i < candidates.length; i++) {
      const orderKey = normalizeOrderReferenceKey(candidates[i]);

      if (orderKey) return orderKey;
    }

    return normalizeMatchText(row.purchaseOrder || row.name || row.sanminaOrderNumber || row.transactionType || row.id);
  }

  function normalizeOrderReferenceKey(value) {
    const text = String(value || '');
    const match = text.match(/\b((?:to|po|so|wo)\s*#?\s*\d+)\b/i) ||
      text.match(/#\s*((?:to|po|so|wo)\s*\d+)/i);

    if (!match) return '';

    return match[1].replace(/[^a-z0-9]/gi, '').toUpperCase();
  }

  function buildDrilldownUniqueKey(row) {
    const transactionKey = row.purchaseOrder ||
      row.sanminaOrderNumber ||
      row.name ||
      row.transactionType ||
      row.id;

    return [
      row.status,
      row.category,
      normalizeMatchText(transactionKey),
      normalizeMatchText(row.sanminaOrderNumber),
      normalizeMatchText(row.transactionType),
      normalizeFingerprintKey(row.failureFingerprint || row.returnMessage || row.category),
      normalizeDrilldownMessage(row.returnMessage)
    ].join('|');
  }

  function normalizeDrilldownMessage(value) {
    return normalizeMatchText(value)
      .replace(/\b(internal\s+id|record\s+id)\s*#?\s*\d+\b/g, '$1 #')
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'date')
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, 'date');
  }

  function compareRowsNewestFirst(a, b) {
    const aDate = parseNsDateTime(a.created);
    const bDate = parseNsDateTime(b.created);
    const aTime = aDate ? aDate.getTime() : 0;
    const bTime = bDate ? bDate.getTime() : 0;
    return bTime - aTime || Number(b.id || 0) - Number(a.id || 0);
  }

  function getTopGroupedValue(rows, keyFn) {
    const map = {};

    rows.forEach(r => {
      const key = keyFn(r) || 'None';
      map[key] = (map[key] || 0) + 1;
    });

    const top = Object.keys(map)
      .map(k => ({ name: k, count: map[k] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))[0];

    return top || { name: 'None', count: 0 };
  }

  function buildOrderRetryUrl(orderId) {
    const cleanOrderId = normalizeInternalId(orderId);
    const retrySuitelet = CONFIG.retrySuitelet || {};

    if (!cleanOrderId || !retrySuitelet.script || !retrySuitelet.deploy) return '';

    const companyId = getRetryCompanyId(retrySuitelet);
    const orderIdParam = retrySuitelet.orderIdParam || 'ordID';
    const params = [
      'script=' + encodeURIComponent(retrySuitelet.script),
      'deploy=' + encodeURIComponent(retrySuitelet.deploy)
    ];

    if (companyId) {
      params.push('compid=' + encodeURIComponent(companyId));
    }

    params.push(encodeURIComponent(orderIdParam) + '=' + encodeURIComponent(cleanOrderId));

    return '/app/site/hosting/scriptlet.nl?' + params.join('&');
  }

  function getRetryCompanyId(retrySuitelet) {
    if (retrySuitelet && retrySuitelet.companyId) {
      return String(retrySuitelet.companyId);
    }

    try {
      return runtime.accountId ? String(runtime.accountId) : '';
    } catch (e) {
      return '';
    }
  }

  function normalizeInternalId(value) {
    const text = String(value || '').trim();
    return /^\d+$/.test(text) ? text : '';
  }

  function resolveRetryOrderInternalId(row) {
    const directId = normalizeInternalId(row.purchase_order_id || row.purchase_order);

    if (directId) return directId;

    const candidates = [
      row.purchase_order,
      row.name,
      row.transaction_type,
      row.sanmina_order_number
    ];

    for (let i = 0; i < candidates.length; i++) {
      const transactionId = findTransactionInternalId(candidates[i]);

      if (transactionId) return transactionId;
    }

    return '';
  }

  function findTransactionInternalId(value) {
    const reference = parseTransactionReference(value);

    if (!reference) return '';

    const cacheKey = reference.prefix + ':' + reference.tranId;

    if (Object.prototype.hasOwnProperty.call(transactionInternalIdCache, cacheKey)) {
      return transactionInternalIdCache[cacheKey];
    }

    const searchTypes = getTransactionSearchTypes(reference.prefix);
    let internalId = '';

    for (let i = 0; i < searchTypes.length; i++) {
      internalId = findTransactionInternalIdBySearchType(searchTypes[i], reference.tranId);

      if (internalId) break;
    }

    transactionInternalIdCache[cacheKey] = internalId;
    return internalId;
  }

  function parseTransactionReference(value) {
    const text = String(value || '');
    const match = text.match(/#\s*((?:to|po|so|wo)\s*#?\s*\d+)/i) ||
      text.match(/\b((?:to|po|so|wo)\s*#?\s*\d+)\b/i);

    if (!match) return null;

    const tranId = match[1].replace(/[^a-z0-9]/gi, '').toUpperCase();
    const prefix = tranId.substring(0, 2);

    if (!/^(TO|PO|SO|WO)\d+$/i.test(tranId)) return null;

    return {
      prefix,
      tranId
    };
  }

  function getTransactionSearchTypes(prefix) {
    const transactionSearchType = getSearchTypeValue('TRANSACTION', 'transaction');
    const typesByPrefix = {
      TO: getSearchTypeValue('TRANSFER_ORDER', 'transferorder'),
      PO: getSearchTypeValue('PURCHASE_ORDER', 'purchaseorder'),
      SO: getSearchTypeValue('SALES_ORDER', 'salesorder'),
      WO: getSearchTypeValue('WORK_ORDER', 'workorder')
    };
    const specificType = typesByPrefix[prefix];

    return specificType && specificType !== transactionSearchType ?
      [specificType, transactionSearchType] :
      [transactionSearchType];
  }

  function getSearchTypeValue(enumName, fallback) {
    try {
      return search.Type && search.Type[enumName] ? search.Type[enumName] : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function findTransactionInternalIdBySearchType(searchType, tranId) {
    const attempts = [true, false];

    for (let i = 0; i < attempts.length; i++) {
      const internalId = runTransactionInternalIdLookup(searchType, tranId, attempts[i]);

      if (internalId) return internalId;
    }

    return '';
  }

  function runTransactionInternalIdLookup(searchType, tranId, useMainlineFilter) {
    const colInternalId = search.createColumn({ name: 'internalid' });
    const filters = [['tranid', 'is', tranId]];

    if (useMainlineFilter) {
      filters.push('AND', ['mainline', 'is', 'T']);
    }

    try {
      const results = search.create({
        type: searchType,
        filters,
        columns: [colInternalId]
      }).run().getRange({
        start: 0,
        end: 1
      });

      if (results && results.length) {
        return normalizeInternalId(results[0].getValue(colInternalId));
      }
    } catch (e) {
      log.error({
        title: 'Retry transaction lookup failed for ' + tranId + ' using ' + searchType,
        details: e
      });
    }

    return '';
  }

  function countFailuresSince(rows, sinceDate) {
    return rows.filter(r => {
      const createdDate = parseNsDateTime(r.created);
      return createdDate && createdDate >= sinceDate;
    }).length;
  }

  function buildFailureFingerprints(rows) {
    const map = {};

    rows.filter(r => r.status === 'FAILED').forEach(r => {
      const key = r.failureFingerprintKey || normalizeFingerprintKey(r.failureFingerprint || r.returnMessage || r.category);

      if (!map[key]) {
        map[key] = {
          fingerprint: r.failureFingerprint || formatCategoryName(r.category),
          category: r.category,
          severity: r.severity,
          priority: r.priority,
          count: 0,
          latestCreated: r.created || ''
        };
      }

      map[key].count += 1;

      if (compareRowsNewestFirst(r, { created: map[key].latestCreated, id: 0 }) < 0) {
        map[key].latestCreated = r.created || map[key].latestCreated;
      }
    });

    return Object.keys(map)
      .map(k => map[k])
      .sort((a, b) => b.count - a.count || getSeverityRank(b.severity) - getSeverityRank(a.severity) || a.fingerprint.localeCompare(b.fingerprint))
      .slice(0, 8);
  }

  function getSeverityRank(severity) {
    const ranks = {
      Critical: 4,
      High: 3,
      Medium: 2,
      Low: 1,
      Info: 0
    };

    return ranks[severity] || 0;
  }

  function buildCategoryBreakdown(rows) {
    const map = {};
    rows.filter(r => r.status === 'FAILED').forEach(r => {
      map[r.category] = (map[r.category] || 0) + 1;
    });

    return Object.keys(map)
      .map(k => ({ category: k, count: map[k] }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  }

  function buildDailyTrend(rows, filters) {
    const map = {};
    const start = isoDateBoundary(filters.dateFrom, false);
    const end = isoDateBoundary(filters.dateTo, false);
    const useWeeklyBuckets = getDateRangeDays(start, end) > 31;

    if (useWeeklyBuckets) {
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
        const bucket = buildTrendBucket(d, start, end);
        map[bucket.date] = bucket;
      }
    } else {
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = toIsoDate(d);
        map[key] = {
          date: key,
          dateFrom: key,
          dateTo: key,
          label: formatShortDate(d),
          title: key,
          success: 0,
          failed: 0,
          unknown: 0
        };
      }
    }

    rows.forEach(r => {
      const createdDate = parseNsDateTime(r.created);
      const key = useWeeklyBuckets && createdDate ? getWeeklyTrendKey(createdDate, start) : (r.createdKey || getCreatedDateKey(r.created));

      if (!map[key]) {
        map[key] = useWeeklyBuckets && createdDate ?
          buildTrendBucket(createdDate, start, end) :
          { date: key, dateFrom: key, dateTo: key, label: key.substring(5), title: key, success: 0, failed: 0, unknown: 0 };
      }

      if (r.status === 'SUCCESS') map[key].success += 1;
      else if (r.status === 'FAILED') map[key].failed += 1;
      else map[key].unknown += 1;
    });

    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
  }

  function buildTrendBucket(dateObj, rangeStart, rangeEnd) {
    const bucketIndex = getWeeklyTrendIndex(dateObj, rangeStart);
    const bucketStart = new Date(rangeStart);
    bucketStart.setDate(rangeStart.getDate() + (bucketIndex * 7));

    const bucketEnd = new Date(bucketStart);
    bucketEnd.setDate(bucketStart.getDate() + 6);

    if (bucketEnd > rangeEnd) {
      bucketEnd.setTime(rangeEnd.getTime());
    }

    const key = toIsoDate(bucketStart);

    return {
      date: key,
      dateFrom: key,
      dateTo: toIsoDate(bucketEnd),
      label: formatShortDateRange(bucketStart, bucketEnd),
      title: toIsoDate(bucketStart) + ' to ' + toIsoDate(bucketEnd),
      success: 0,
      failed: 0,
      unknown: 0
    };
  }

  function getWeeklyTrendKey(dateObj, rangeStart) {
    const bucketStart = new Date(rangeStart);
    bucketStart.setDate(rangeStart.getDate() + (getWeeklyTrendIndex(dateObj, rangeStart) * 7));
    return toIsoDate(bucketStart);
  }

  function getWeeklyTrendIndex(dateObj, rangeStart) {
    const dayMs = 24 * 60 * 60 * 1000;
    return Math.max(0, Math.floor((stripTime(dateObj).getTime() - stripTime(rangeStart).getTime()) / (dayMs * 7)));
  }

  function buildTopVendors(rows) {
    const map = {};
    rows.forEach(r => {
      const key = r.purchaseOrder || r.sanminaOrderNumber || 'No PO / TO';
      if (!map[key]) map[key] = { name: key, total: 0, failed: 0, success: 0, unknown: 0 };
      map[key].total += 1;
      if (r.status === 'FAILED') map[key].failed += 1;
      if (r.status === 'SUCCESS') map[key].success += 1;
      if (r.status === 'UNKNOWN') map[key].unknown += 1;
    });

    return Object.keys(map)
      .map(k => map[k])
      .sort((a, b) => b.total - a.total || b.failed - a.failed)
      .slice(0, 8);
  }

  function handleRetry(id, recordType) {
    if (!id) return { ok: false, message: 'Missing record id.' };

    if (!CONFIG.enableRetry) {
      return {
        ok: false,
        message: 'Retry is disabled until retry request fields are configured.'
      };
    }

    const retryRecordType = getRetryRecordType(recordType);

    if (!retryRecordType) {
      return {
        ok: false,
        message: 'Missing response record type for retry.'
      };
    }

    try {
      const responseRecord = record.load({
        type: retryRecordType,
        id,
        isDynamic: false
      });
      const values = buildRetrySubmitValues(responseRecord, id);
      const fieldCount = Object.keys(values).length;

      if (!fieldCount) {
        return {
          ok: false,
          message: 'No retry trigger field was found on ' + retryRecordType + '. Add one of the configured retry checkbox/status fields, or wire handleRetry() to the integration processor.'
        };
      }

      record.submitFields({
        type: retryRecordType,
        id,
        values,
        options: {
          enableSourcing: false,
          ignoreMandatoryFields: true
        }
      });

      return {
        ok: true,
        message: 'Retry requested for response record ' + id + '. Updated ' + fieldCount + ' retry field(s).'
      };
    } catch (e) {
      log.error({
        title: 'Integration retry request failed for response record ' + id,
        details: e
      });

      return {
        ok: false,
        message: 'Retry request failed for response record ' + id + ': ' + (e && e.message ? e.message : String(e))
      };
    }
  }

  function getRetryRecordType(recordType) {
    const candidate = String(recordType || '').trim().toLowerCase();

    if (candidate && /^[a-z][a-z0-9_]*$/.test(candidate)) {
      return candidate;
    }

    return getConfiguredRecordTypeInfo({}).recordType || CONFIG.recordType || '';
  }

  function buildRetrySubmitValues(responseRecord, id) {
    const values = {};
    const requestedAt = new Date();
    const retryConfig = CONFIG.retry || {};
    const flagField = findCompatibleRecordField(responseRecord, retryConfig.flagFields, isCheckboxFieldType);
    const dateField = findCompatibleRecordField(responseRecord, retryConfig.dateFields, isDateLikeFieldType);
    const statusField = findCompatibleRecordField(responseRecord, retryConfig.statusFields, isTextLikeFieldType);
    const noteField = findCompatibleRecordField(responseRecord, retryConfig.noteFields, isTextLikeFieldType);

    if (!flagField && !statusField) {
      return values;
    }

    if (flagField) values[flagField] = true;
    if (dateField) values[dateField] = requestedAt;
    if (statusField) values[statusField] = 'Pending Retry';
    if (noteField) {
      values[noteField] = 'Retry requested from Integration Error Monitoring Dashboard on ' +
        requestedAt.toISOString() +
        ' for response record ' +
        id +
        '.';
    }

    return values;
  }

  function findCompatibleRecordField(responseRecord, fieldIds, typePredicate) {
    const ids = normalizeFieldIdList(fieldIds);

    for (let i = 0; i < ids.length; i++) {
      const fieldId = ids[i];
      const fieldType = getRecordFieldType(responseRecord, fieldId);

      if (fieldType && typePredicate(fieldType)) {
        return fieldId;
      }
    }

    return '';
  }

  function getRecordFieldType(responseRecord, fieldId) {
    try {
      const field = responseRecord.getField({ fieldId });

      return field && field.type ? String(field.type).toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  function isCheckboxFieldType(fieldType) {
    return String(fieldType || '').toLowerCase() === 'checkbox';
  }

  function isDateLikeFieldType(fieldType) {
    const type = String(fieldType || '').toLowerCase();
    return type === 'date' || type === 'datetime' || type === 'datetimetz';
  }

  function isTextLikeFieldType(fieldType) {
    const type = String(fieldType || '').toLowerCase();
    return type === 'text' ||
      type === 'textarea' ||
      type === 'longtext' ||
      type === 'richtext' ||
      type === 'richtextarea' ||
      type === 'inlinehtml';
  }

  function buildHtml(suiteletUrl, data) {
    const filters = data.filters || getDefaultDateRange();
    const rows = data.rows || [];
    const drilldownRows = data.drilldownRows || rows;
    const viewModeLabel = getViewModeLabel(filters.viewMode);

    return `
${buildCss()}
<div class="dash">
  <div class="dash-topbar">
    <div>
      <h1>${esc(CONFIG.dashboardTitle)}</h1>
      <div class="dash-sub">${esc(viewModeLabel)} · Selected range: ${esc(filters.dateFrom)} to ${esc(filters.dateTo)} · ${esc(getTrendGroupingLabel(filters))}</div>
    </div>
    <div class="dash-topbar-right">
      <div id="lastRefreshed" class="dash-refresh" data-generated-at="${escAttr(data.generatedAt || '')}">${esc(formatLastRefreshedText(data.generatedAt))}</div>
      <div class="dash-actions">
        <button type="button" class="btn btn-primary" onclick="applyFilters(true)">Refresh</button>
        <button type="button" class="btn" onclick="resetDefaultRange()">Default Range</button>
        <button type="button" id="autoRefreshToggle" class="btn" onclick="toggleAutoRefresh()">Auto Refresh Off</button>
        <select id="autoRefreshInterval" class="auto-refresh-select" onchange="setAutoRefreshInterval(this.value)" aria-label="Auto refresh interval">
          <option value="60">1 min</option>
          <option value="300">5 min</option>
          <option value="900">15 min</option>
        </select>
      </div>
      <div id="autoRefreshStatus" class="auto-refresh-status">Auto refresh off</div>
    </div>
  </div>

  ${data.error ? `<div class="error-banner">Unable to load dashboard data: ${esc(data.error)}</div>` : ''}
  ${data.error ? buildSourceHelpHtml(data) : ''}
  ${buildQueryLimitWarningHtml(data.searchStats || buildEmptySearchStats())}

  ${buildFilterHtml(filters, data.recordType || '')}
  ${buildKpiHtml(data.summary)}
  ${buildInsightsHtml(data.insights || buildInsights(rows))}

  <div class="analysis-grid">
    <section class="panel trend-panel">
      <div class="panel-head">
        <div>
          <h2>Error / Success Trend</h2>
          <span>${esc(filters.dateFrom)} to ${esc(filters.dateTo)} · ${esc(getTrendGroupingLabel(filters))}</span>
        </div>
      </div>
      ${buildTrendSvg(data.dailyTrend || [])}
      ${buildTrendExtremesHtml(data.dailyTrend || [])}
    </section>

    <section class="panel activity-panel category-panel">
      <div class="panel-head">
        <div>
          <h2>Error Categories</h2>
          <span>Failed records only, grouped by return message</span>
        </div>
      </div>
      ${buildCategoryCircle(data.categoryBreakdown || [])}
    </section>
  </div>

  <div class="analysis-grid lower">
    <section class="panel activity-panel">
      <div class="panel-head">
        <div>
          <h2>Top PO / TO Activity</h2>
          <span>Highest volume, split by failed and successful responses</span>
        </div>
      </div>
      ${buildTopActivityBars(data.topVendors || [])}
    </section>

    <section class="panel mix-panel">
      <div class="panel-head">
        <div>
          <h2>Failure Mix</h2>
          <span>Success, failed, and unknown response mix</span>
        </div>
      </div>
      ${buildStatusMix(data.summary)}
    </section>
  </div>

  <section class="panel table-panel">
    <div class="panel-head">
      <div>
        <h2>Transaction Drilldown</h2>
        <span id="drilldownCount">${esc(buildDrilldownCountText(drilldownRows.length, filters))}</span>
      </div>
    </div>
    ${buildTableHtml(drilldownRows, filters)}
  </section>

  <div class="dash-footer">
    <span>Developed by ${esc(CONFIG.developedBy)}</span>
    <span class="version-badge">v${esc(CONFIG.version)}</span>
  </div>
</div>

${buildMessageModalHtml()}
${buildScript(suiteletUrl, filters)}
`;
  }

  function formatLastRefreshedText(value) {
    const refreshedAt = value ? new Date(value) : new Date();

    if (!refreshedAt || isNaN(refreshedAt.getTime())) {
      return 'Last refreshed: Unknown';
    }

    let hours = refreshedAt.getHours();
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return 'Last refreshed: ' +
      pad2(refreshedAt.getMonth() + 1) + '/' +
      pad2(refreshedAt.getDate()) + '/' +
      refreshedAt.getFullYear() + ' ' +
      hours + ':' +
      pad2(refreshedAt.getMinutes()) + ' ' +
      suffix;
  }

  function buildSourceHelpHtml(data) {
    const candidates = data.candidates || [];

    return `
<section class="source-help">
  <div>
    <h2>Choose the response record source</h2>
    <p>Enter the custom record type Internal ID that stores the integration responses. It should start with <code>customrecord_</code>.</p>
  </div>
  ${candidates.length ? `
    <div class="candidate-list">
      <div class="candidate-title">Possible custom record types found in this account</div>
      ${candidates.map(c => `
        <button type="button" class="candidate-btn" onclick="useRecordType('${escAttr(c.scriptid)}')" title="${escAttr(c.name)}">
          <b>${esc(c.scriptid)}</b>
          <span>${esc(c.name || 'Unnamed custom record')}</span>
        </button>
      `).join('')}
    </div>
  ` : `
    <div class="candidate-empty">No custom record type metadata was available to this script. Enter the record type manually below.</div>
  `}
</section>`;
  }

  function buildQueryLimitWarningHtml(searchStats) {
    if (!searchStats || !searchStats.hitQueryLimit) return '';

    const queryLimit = formatWholeNumber(searchStats.queryLimit || CONFIG.queryLimit);

    return `<div class="warning-banner">Showing first ${esc(queryLimit)} searched records. Narrow date range for complete results.</div>`;
  }

  function formatWholeNumber(value) {
    return String(Number(value || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function getViewModeLabel(viewMode) {
    return viewMode === 'HISTORY' ? 'History view' : 'Current status view';
  }

  function getDrilldownRecordLabel(filters) {
    return filters && filters.viewMode === 'HISTORY' ? 'response record(s)' : 'current transaction record(s)';
  }

  function buildInsightsHtml(insights) {
    const cards = [
      {
        label: 'Latest Failure',
        value: insights.latestFailure || 'None',
        detail: insights.latestFailureDetail || 'No failed records in this view.'
      },
      {
        label: 'Top Failure Reason',
        value: formatCategoryName(insights.topFailureCategory || 'None'),
        detail: Number(insights.topFailureCount || 0) + ' failed record(s)'
      },
      {
        label: 'Top Failing PO / TO',
        value: truncateText(insights.topFailingPo || 'None', 34),
        detail: Number(insights.topFailingPoCount || 0) + ' failed record(s)'
      },
      {
        label: 'Last 24 Hours',
        value: insights.failuresLast24Hours || 0,
        detail: 'Failed records'
      },
      {
        label: 'Retry Mode',
        value: insights.retryMode || 'Disabled',
        detail: CONFIG.enableRetry ? 'Retry request action is available.' : 'Hidden until retry request fields are configured.'
      }
    ];

    return `<div class="insight-grid">${cards.map(c => `
      <div class="insight-card">
        <div class="insight-label">${esc(c.label)}</div>
        <div class="insight-value" title="${escAttr(c.value)}">${esc(c.value)}</div>
        <div class="insight-detail">${esc(c.detail)}</div>
      </div>`).join('')}</div>`;
  }

  function buildMessageModalHtml() {
    return `
<div id="messageModal" class="modal-backdrop" aria-hidden="true">
  <div class="message-modal" role="dialog" aria-modal="true" aria-labelledby="messageModalTitle">
    <div class="message-modal-head">
      <h2 id="messageModalTitle">Return Message</h2>
      <button type="button" class="icon-btn" onclick="closeMessageModal()" aria-label="Close message">x</button>
    </div>
    <pre id="messageModalBody"></pre>
  </div>
</div>`;
  }

  function buildFilterHtml(filters, recordType) {
    const recordTypeInputHtml = recordType ? `
  <input id="recordType" type="hidden" value="${escAttr(recordType)}">` : `
  <label>Record Type
    <input id="recordType" type="text" value="" placeholder="customrecord_...">
  </label>`;
    const currentActive = filters.viewMode !== 'HISTORY';
    const historyActive = filters.viewMode === 'HISTORY';

    return `
<div class="preset-row" aria-label="Date presets">
  <button type="button" class="preset-btn${getPresetButtonClass(filters, '7')}" onclick="setDatePreset(7)">7D</button>
  <button type="button" class="preset-btn${getPresetButtonClass(filters, '30')}" onclick="setDatePreset(30)">30D</button>
  <button type="button" class="preset-btn${getPresetButtonClass(filters, '90')}" onclick="setDatePreset(90)">90D</button>
  <button type="button" class="preset-btn${getPresetButtonClass(filters, 'YTD')}" onclick="setDatePreset('YTD')">YTD</button>
  <button type="button" class="preset-btn${getPresetButtonClass(filters, 'ALL')}" onclick="setDatePreset('ALL')">All</button>
</div>
<div class="filters">
  ${recordTypeInputHtml}
  <label>View
    <input id="viewMode" type="hidden" value="${escAttr(filters.viewMode || 'CURRENT')}">
    <span class="mode-toggle" role="group" aria-label="Dashboard view mode">
      <button type="button" class="mode-btn${currentActive ? ' active' : ''}" onclick="setViewMode('CURRENT')">Current</button>
      <button type="button" class="mode-btn${historyActive ? ' active' : ''}" onclick="setViewMode('HISTORY')">History</button>
    </span>
  </label>
  <label>From
    <input id="dateFrom" type="date" value="${escAttr(filters.dateFrom)}">
  </label>
  <label>To
    <input id="dateTo" type="date" value="${escAttr(filters.dateTo)}">
  </label>
  <label>Status
    <select id="statusFilter">
      ${buildStatusOptions(filters.status)}
    </select>
  </label>
  <label>Category
    <select id="categoryFilter">
      ${buildCategoryOptions(filters.category)}
    </select>
  </label>
  <label>Search
    <input id="globalSearch" type="text" value="${escAttr(filters.search)}" placeholder="PO, message, order number">
  </label>
</div>`;
  }

  function buildStatusOptions(selected) {
    return [
      { value: 'ALL', text: 'All' },
      { value: 'SUCCESS', text: 'Success' },
      { value: 'FAILED', text: 'Failed' },
      { value: 'UNKNOWN', text: 'Unknown' }
    ].map(o => {
      return `<option value="${o.value}" ${selected === o.value ? 'selected' : ''}>${o.text}</option>`;
    }).join('');
  }

  function buildCategoryOptions(selected) {
    return [
      { value: 'ALL', text: 'All' },
      { value: 'PRICE_LIST', text: 'Price List' },
      { value: 'UOM_CONVERSION', text: 'UOM Conversion' },
      { value: 'ITEM_XREF', text: 'Item Xref' },
      { value: 'VALIDATION', text: 'Validation' },
      { value: 'ORDER_TYPE', text: 'Order Type' },
      { value: 'OTHER_ERROR', text: 'Other Error' },
      { value: 'UNKNOWN', text: 'Unknown' }
    ].map(o => {
      return `<option value="${o.value}" ${selected === o.value ? 'selected' : ''}>${o.text}</option>`;
    }).join('');
  }

  function buildKpiHtml(summary) {
    const comparison = summary.comparison || {};
    const cards = [
      { label: 'Total', value: summary.total, className: '', action: 'clearResultFilters()', deltaKey: 'total', deltaGoodWhenUp: null },
      { label: 'Success', value: summary.success, className: 'good', action: "applyStatusFilter('SUCCESS')", deltaKey: 'success', deltaGoodWhenUp: true },
      { label: 'Failed', value: summary.failed, className: 'bad', action: "applyStatusFilter('FAILED')", deltaKey: 'failed', deltaGoodWhenUp: false },
      { label: 'Unknown', value: summary.unknown, className: 'neutral', action: "applyStatusFilter('UNKNOWN')", deltaKey: 'unknown', deltaGoodWhenUp: false },
      { label: 'Success Rate', value: summary.successRate + '%', className: 'good', action: "applyStatusFilter('SUCCESS')", deltaKey: 'successRate', deltaGoodWhenUp: true },
      { label: 'Failure Rate', value: Number(summary.failureRate || 0) + '%', className: 'bad', action: "applyStatusFilter('FAILED')", deltaKey: 'failureRate', deltaGoodWhenUp: false },
      { label: 'Top Category', value: formatCategoryName(summary.topCategory || 'None'), className: 'wide', action: `applyCategoryFilter(${JSON.stringify(String(summary.topCategory || 'ALL'))})`, delta: comparison.topCategory ? 'Prior: ' + formatCategoryName(comparison.topCategory) : '' }
    ];

    return `<div class="kpi-grid">${cards.map(c => `
      <button type="button" class="kpi-card ${c.className}" onclick="${escAttr(c.action)}" title="Apply ${escAttr(c.label)} filter">
        <div class="kpi-label">${esc(c.label)}</div>
        <div class="kpi-value">${esc(c.value)}</div>
        ${buildKpiDeltaHtml(c, comparison)}
      </button>`).join('')}</div>`;
  }

  function buildKpiDeltaHtml(card, comparison) {
    const deltaText = card.delta || buildKpiDeltaText(comparison[card.deltaKey]);

    if (!deltaText) return '';

    return `<div class="kpi-delta ${escAttr(getKpiDeltaTone(comparison[card.deltaKey], card.deltaGoodWhenUp))}">${esc(deltaText)}</div>`;
  }

  function buildKpiDeltaText(comparisonValue) {
    if (!comparisonValue) return '';

    const delta = Number(comparisonValue.delta || 0);
    const suffix = comparisonValue.isPercent ? '%' : '';
    const absDelta = comparisonValue.isPercent ? formatRateValue(Math.abs(delta)) : String(Math.abs(delta));
    const sign = delta > 0 ? '+' : delta < 0 ? '-' : '';

    return '(' + sign + absDelta + suffix + ' vs prior)';
  }

  function getKpiDeltaTone(comparisonValue, goodWhenUp) {
    if (!comparisonValue || goodWhenUp === null) return 'neutral';

    const delta = Number(comparisonValue.delta || 0);
    if (!delta) return 'neutral';

    return (delta > 0) === !!goodWhenUp ? 'good' : 'bad';
  }

  function formatRateValue(value) {
    const rounded = Math.round(Number(value || 0) * 10) / 10;
    return rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded);
  }

  function buildTrendSvg(trend) {
    const width = 900;
    const height = 330;
    const left = 50;
    const right = 22;
    const top = 34;
    const bottom = 98;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const totals = trend.map(d => Math.max(d.success, d.failed, d.unknown));
    const max = Math.max(1, Math.max.apply(null, totals.concat([0])));
    const count = Math.max(1, trend.length);
    const slot = plotWidth / count;
    const groupWidth = Math.max(16, Math.min(58, slot * 0.74));
    const gap = groupWidth > 26 ? 3 : 2;
    const barWidth = Math.max(4, (groupWidth - (gap * 2)) / 3);
    const labelEvery = count > 32 ? Math.ceil(count / 16) : 1;
    const trendOverlay = buildTrendOverlayLines(trend, {
      left,
      top,
      plotHeight,
      slot,
      max
    });

    const trendPieces = trend.map((d, i) => {
      const groupX = left + (slot * i) + ((slot - groupWidth) / 2);
      const labelX = left + (slot * i) + (slot / 2);
      const baseline = top + plotHeight;
      const title = d.title || d.date;
      const bucketFrom = d.dateFrom || d.date;
      const bucketTo = d.dateTo || d.date;
      const label = d.label || d.date.substring(5);
      const showLabel = i === 0 || i === count - 1 || i % labelEvery === 0;
      const series = [
        { key: 'failed', status: 'FAILED', label: 'Failed', value: d.failed, fill: 'url(#trendFailedGradient)' },
        { key: 'success', status: 'SUCCESS', label: 'Success', value: d.success, fill: 'url(#trendSuccessGradient)' },
        { key: 'unknown', status: 'UNKNOWN', label: 'Unknown', value: d.unknown, fill: 'url(#trendUnknownGradient)' }
      ];

      const rects = series.map((s, seriesIndex) => {
        const barHeight = Math.round((s.value / max) * plotHeight);
        const x = groupX + (seriesIndex * (barWidth + gap));
        const y = baseline - barHeight;
        const clickAttrs = s.value > 0 && isIsoDate(bucketFrom) && isIsoDate(bucketTo) ?
          `class="trend-bar trend-bar-clickable" onclick="applyTrendFilter(${jsString(s.status)},${jsString(bucketFrom)},${jsString(bucketTo)})"` :
          'class="trend-bar"';

        return `<rect ${clickAttrs} x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${s.fill}" rx="3"><title>${escAttr(title)} ${s.label.toLowerCase()}: ${s.value}</title></rect>`;
      }).join('');
      const labels = series.map((s, seriesIndex) => {
        const barHeight = Math.round((s.value / max) * plotHeight);
        const x = groupX + (seriesIndex * (barWidth + gap));
        const y = baseline - barHeight;
        const labelY = Math.max(top + 12, y - 6);

        return s.value > 0 && s.key !== 'unknown' ?
          `<text x="${x + (barWidth / 2)}" y="${labelY}" text-anchor="middle" class="bar-value-label">${s.value}</text>` :
          '';
      }).join('');
      const axisLabel = showLabel ?
        `<text x="${labelX}" y="${height - 42}" text-anchor="end" class="axis-label" transform="rotate(-42 ${labelX} ${height - 42})"><title>${escAttr(title)}</title>${esc(label)}</text>` :
        '';

      return {
        rects,
        labels: labels + axisLabel
      };
    });
    const bars = trendPieces.map(piece => piece.rects).join('');
    const barLabels = trendPieces.map(piece => piece.labels).join('');

    const grid = [0, 0.25, 0.5, 0.75, 1].map(p => {
      const y = top + plotHeight - (plotHeight * p);
      const label = Math.round(max * p);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid-line"></line><text x="8" y="${y + 4}" class="axis-label">${label}</text>`;
    }).join('');

    return `
<div class="chart-wrap trend-chart-wrap">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Error success trend">
    <defs>
      <linearGradient id="trendBackgroundGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#e0f7ff"></stop>
        <stop offset="42%" stop-color="#f6fbff"></stop>
        <stop offset="100%" stop-color="#ffffff"></stop>
      </linearGradient>
      <linearGradient id="trendWaveGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#bae6fd" stop-opacity=".82"></stop>
        <stop offset="48%" stop-color="#a7f3d0" stop-opacity=".44"></stop>
        <stop offset="100%" stop-color="#dbeafe" stop-opacity=".74"></stop>
      </linearGradient>
      <linearGradient id="trendSuccessGradient" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#14b8a6"></stop>
        <stop offset="100%" stop-color="#5eead4"></stop>
      </linearGradient>
      <linearGradient id="trendFailedGradient" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#f97316"></stop>
        <stop offset="100%" stop-color="#fdba74"></stop>
      </linearGradient>
      <linearGradient id="trendUnknownGradient" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#94a3b8"></stop>
        <stop offset="100%" stop-color="#cbd5e1"></stop>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="16" class="trend-chart-bg"></rect>
    <path d="M 0 246 C 130 232 238 268 372 250 C 522 230 642 214 900 232 L 900 330 L 0 330 Z" class="trend-chart-wave"></path>
    ${grid}
    ${bars}
    ${trendOverlay}
    ${barLabels}
    <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" class="axis-line"></line>
  </svg>
  <div class="legend"><span class="dot good"></span>Success <span class="dot bad"></span>Failed <span class="dot neutral"></span>Unknown</div>
</div>`;
  }

  function buildTrendOverlayLines(trend, chart) {
    const series = [
      { key: 'success', label: 'Success', className: 'success' },
      { key: 'failed', label: 'Failed', className: 'failed' },
      { key: 'unknown', label: 'Unknown', className: 'unknown' }
    ];
    const overlays = series.map(s => buildTrendOverlaySeries(trend, chart, s)).join('');

    return overlays ? `<g class="trend-overlay">${overlays}</g>` : '';
  }

  function buildTrendOverlaySeries(trend, chart, series) {
    const points = buildTrendOverlaySeriesPoints(trend, chart, series.key);

    if (!points.length) return '';

    const line = points.length > 1 ?
      `<path class="trend-overlay-line ${escAttr(series.className)}" d="${escAttr(buildSmoothTrendPath(points))}"><title>${esc(series.label)} trend line</title></path>` :
      '';
    const markers = points.map(point => {
      const title = (point.title ? point.title + ' ' : '') + series.label.toLowerCase() + ': ' + point.value;

      return `<circle class="trend-overlay-point ${escAttr(series.className)}" cx="${point.x}" cy="${point.y}" r="4"><title>${escAttr(title)}</title></circle>`;
    }).join('');

    return line + markers;
  }

  function buildTrendOverlaySeriesPoints(trend, chart, key) {
    const baseline = chart.top + chart.plotHeight;
    const scaleMax = Math.max(1, Number(chart.max || 1));

    return (trend || []).map((d, i) => {
      const value = Number(d[key] || 0);
      return {
        x: roundSvgNumber(chart.left + (chart.slot * i) + (chart.slot / 2)),
        y: roundSvgNumber(baseline - ((value / scaleMax) * chart.plotHeight)),
        value,
        title: d.title || d.date || ''
      };
    }).filter(point => point.value > 0);
  }

  function buildSmoothTrendPath(points) {
    if (!points.length) return '';

    let path = 'M ' + points[0].x + ' ' + points[0].y;

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const cp1x = roundSvgNumber(p1.x + ((p2.x - p0.x) / 6));
      const cp1y = roundSvgNumber(p1.y + ((p2.y - p0.y) / 6));
      const cp2x = roundSvgNumber(p2.x - ((p3.x - p1.x) / 6));
      const cp2y = roundSvgNumber(p2.y - ((p3.y - p1.y) / 6));

      path += ' C ' + cp1x + ' ' + cp1y + ' ' + cp2x + ' ' + cp2y + ' ' + p2.x + ' ' + p2.y;
    }

    return path;
  }

  function roundSvgNumber(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function buildTrendExtremesHtml(trend) {
    const gauges = [
      {
        key: 'failed',
        label: 'Failed Peak',
        subLabel: 'Failed Response Range',
        metric: 'failed',
        minLabel: 'Lowest Failed',
        maxLabel: 'Highest Failed',
        gradientStart: '#f97316',
        gradientMid: '#fbbf24',
        gradientEnd: '#22c55e'
      },
      {
        key: 'success',
        label: 'Success Peak',
        subLabel: 'Success Response Range',
        metric: 'success',
        minLabel: 'Lowest Success',
        maxLabel: 'Highest Success',
        gradientStart: '#38bdf8',
        gradientMid: '#84cc16',
        gradientEnd: '#facc15'
      }
    ];

    const gaugeCards = gauges.map(gauge => {
      return {
        gauge,
        min: getTrendExtreme(trend, gauge.metric, 'min'),
        max: getTrendExtreme(trend, gauge.metric, 'max')
      };
    });
    const scaleMax = getTrendGaugeScaleMax(gaugeCards);

    return `
<div class="trend-gauge-grid">
  ${gaugeCards.map(gaugeCard => buildTrendGaugeCard(gaugeCard, scaleMax)).join('')}
</div>`;
  }

  function buildTrendGaugeCard(gaugeCard, scaleMax) {
    const gauge = gaugeCard.gauge;
    const min = gaugeCard.min;
    const max = gaugeCard.max;
    const value = Number(max.value || 0);

    return `
<div class="trend-gauge-card ${escAttr(gauge.key)}" title="${escAttr(max.title)}">
  ${buildTrendGaugeSvg(gauge, value, scaleMax)}
  <div class="trend-gauge-value">${esc(value)}</div>
  <div class="trend-gauge-label">${esc(gauge.label)}</div>
  <div class="trend-gauge-stats">
    <div>
      <b>${esc(gauge.minLabel)}</b>
      <span>${esc(min.value)} · ${esc(min.label)}</span>
    </div>
    <div>
      <b>${esc(gauge.maxLabel)}</b>
      <span>${esc(max.value)} · ${esc(max.label)}</span>
    </div>
  </div>
</div>`;
  }

  function getTrendGaugeScaleMax(gaugeCards) {
    return Math.max.apply(null, (gaugeCards || []).map(gaugeCard => Number(gaugeCard.max.value || 0)).concat([0]));
  }

  function buildTrendGaugeSvg(gauge, value, scaleMax) {
    const width = 280;
    const height = 150;
    const cx = 140;
    const cy = 122;
    const radius = 86;
    const percent = getGaugeNeedlePercent(getGaugePercent(value, scaleMax));
    const needleTip = getGaugePoint(cx, cy, radius - 6, percent);
    const needleBaseLeft = getGaugeNeedleBase(cx, cy, percent, -5);
    const needleBaseRight = getGaugeNeedleBase(cx, cy, percent, 5);
    const gradientId = 'trendGaugeGradient_' + gauge.key;

    return `
<svg class="trend-gauge-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escAttr(gauge.subLabel)}">
  <defs>
    <linearGradient id="${escAttr(gradientId)}" x1="30" y1="122" x2="250" y2="122" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${escAttr(gauge.gradientStart)}"></stop>
      <stop offset="52%" stop-color="${escAttr(gauge.gradientMid)}"></stop>
      <stop offset="100%" stop-color="${escAttr(gauge.gradientEnd)}"></stop>
    </linearGradient>
  </defs>
  <path d="M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}" class="trend-gauge-track"></path>
  <path d="M ${cx - radius} ${cy} A ${radius} ${radius} 0 0 1 ${cx + radius} ${cy}" class="trend-gauge-arc" stroke="url(#${escAttr(gradientId)})"></path>
  <path d="M ${needleBaseLeft.x} ${needleBaseLeft.y} L ${needleTip.x} ${needleTip.y} L ${needleBaseRight.x} ${needleBaseRight.y} Z" class="trend-gauge-needle"></path>
  <circle cx="${cx}" cy="${cy}" r="6" class="trend-gauge-hub"></circle>
</svg>`;
  }

  function getGaugePercent(value, scaleMax) {
    if (!scaleMax) return 0;
    return Math.max(0, Math.min(1, Number(value || 0) / scaleMax));
  }

  function getGaugeNeedlePercent(percent) {
    return 0.08 + (Math.max(0, Math.min(1, Number(percent || 0))) * 0.84);
  }

  function getGaugePoint(cx, cy, radius, percent) {
    const angle = Math.PI - (Math.PI * percent);

    return {
      x: Math.round((cx + (radius * Math.cos(angle))) * 100) / 100,
      y: Math.round((cy - (radius * Math.sin(angle))) * 100) / 100
    };
  }

  function getGaugeNeedleBase(cx, cy, percent, offset) {
    const angle = Math.PI - (Math.PI * percent);
    const perpendicular = angle + (Math.PI / 2);

    return {
      x: Math.round((cx + (offset * Math.cos(perpendicular))) * 100) / 100,
      y: Math.round((cy - (offset * Math.sin(perpendicular))) * 100) / 100
    };
  }

  function getTrendExtreme(trend, metric, mode) {
    const rows = (trend || []).map(d => {
      return {
        value: Number(d[metric] || 0),
        label: d.label || String(d.date || '').substring(5) || 'No date',
        title: d.title || d.date || 'No date'
      };
    }).filter(d => d.value > 0);

    if (!rows.length) {
      return {
        value: 0,
        label: 'No records',
        title: 'No records in this range'
      };
    }

    return rows.sort((a, b) => {
      if (mode === 'max') return b.value - a.value || a.title.localeCompare(b.title);
      return a.value - b.value || a.title.localeCompare(b.title);
    })[0];
  }

  function getPresetButtonClass(filters, preset) {
    return getActivePresetKey(filters) === String(preset) ? ' active' : '';
  }

  function getActivePresetKey(filters) {
    const start = isoDateBoundary(filters.dateFrom, false);
    const end = isoDateBoundary(filters.dateTo, false);
    const days = getDateRangeDays(start, end);
    const yearStart = new Date(end.getFullYear(), 0, 1);

    if (days === 7 || days === 30 || days === 90) return String(days);
    if (filters.dateFrom === '2000-01-01') return 'ALL';
    if (filters.dateFrom === toIsoDate(yearStart)) return 'YTD';

    return '';
  }

  function buildCategoryCircle(categories) {
    if (!categories.length) return `<div class="empty-chart">No failed category data for this date range.</div>`;

    const width = 360;
    const height = 340;
    const cx = 180;
    const cy = 148;
    const outerRadius = 96;
    const innerRadius = 54;
    const labelRadius = 132;
    const total = categories.reduce((sum, c) => sum + Number(c.count || 0), 0);
    let angle = 0;

    const gradients = categories.map((c, i) => {
      return `
        <linearGradient id="categoryGradient${i}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${getCategoryColor(c.category)}"></stop>
          <stop offset="100%" stop-color="${getCategoryGradientEndColor(c.category)}"></stop>
        </linearGradient>`;
    }).join('');

    const slices = categories.map((c, i) => {
      const value = Number(c.count || 0);
      const startAngle = angle;
      const endAngle = angle + ((value / Math.max(1, total)) * 360);
      const midAngle = startAngle + ((endAngle - startAngle) / 2);
      const labelPoint = polarToCartesian(cx, cy, labelRadius, midAngle);
      const path = describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle);
      const textAnchor = labelPoint.x < cx - 8 ? 'end' : labelPoint.x > cx + 8 ? 'start' : 'middle';

      angle = endAngle;

      return `
        <path class="category-slice" d="${path}" fill="url(#categoryGradient${i})" onclick="applyCategoryFilter(${jsString(c.category)})">
          <title>${esc(formatCategoryName(c.category))}: ${value}</title>
        </path>
        <text x="${labelPoint.x}" y="${labelPoint.y - 4}" text-anchor="${textAnchor}" class="category-circle-label">${esc(formatCategoryName(c.category))}</text>
        <text x="${labelPoint.x}" y="${labelPoint.y + 10}" text-anchor="${textAnchor}" class="category-circle-count">${value}</text>`;
    }).join('');

    return `
<div class="category-circle-wrap">
  <svg class="category-circle-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Failure categories">
    <defs>
      <linearGradient id="categoryPanelGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#fff7ed"></stop>
        <stop offset="44%" stop-color="#f8fcff"></stop>
        <stop offset="100%" stop-color="#ecfeff"></stop>
      </linearGradient>
      <radialGradient id="categoryGlowGradient" cx="50%" cy="40%" r="58%">
        <stop offset="0%" stop-color="#fed7aa" stop-opacity=".46"></stop>
        <stop offset="52%" stop-color="#bae6fd" stop-opacity=".24"></stop>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"></stop>
      </radialGradient>
      <linearGradient id="categoryWaveGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fb923c" stop-opacity=".16"></stop>
        <stop offset="48%" stop-color="#38bdf8" stop-opacity=".12"></stop>
        <stop offset="100%" stop-color="#14b8a6" stop-opacity=".16"></stop>
      </linearGradient>
      ${gradients}
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="18" class="category-chart-bg"></rect>
    <circle cx="${cx}" cy="${cy}" r="142" class="category-chart-glow"></circle>
    <path d="M 0 258 C 76 238 126 278 198 256 C 266 235 306 246 360 224 L 360 340 L 0 340 Z" class="category-chart-wave"></path>
    <circle cx="${cx}" cy="${cy}" r="${outerRadius + 14}" class="category-orbit"></circle>
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 6}" class="category-circle-center"></circle>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" class="category-circle-total">${total}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="category-circle-sub">Failures</text>
  </svg>
  <div class="category-circle-legend">
    ${categories.map((c, i) => `
      <button type="button" class="category-chip" onclick="applyCategoryFilter(${jsString(c.category)})" title="Filter table to ${escAttr(formatCategoryName(c.category))}">
        <span class="category-chip-dot" style="background:linear-gradient(135deg,${getCategoryColor(c.category)},${getCategoryGradientEndColor(c.category)})"></span>
        <b>${esc(formatCategoryName(c.category))}</b>
        <small>${Number(c.count || 0)}</small>
      </button>`).join('')}
  </div>
</div>`;
  }

  function polarToCartesian(cx, cy, radius, angleInDegrees) {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180;

    return {
      x: Math.round((cx + (radius * Math.cos(angleInRadians))) * 100) / 100,
      y: Math.round((cy + (radius * Math.sin(angleInRadians))) * 100) / 100
    };
  }

  function describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
    const cappedEndAngle = Math.min(endAngle, startAngle + 359.99);
    const outerStart = polarToCartesian(cx, cy, outerRadius, cappedEndAngle);
    const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
    const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
    const innerEnd = polarToCartesian(cx, cy, innerRadius, cappedEndAngle);
    const largeArcFlag = cappedEndAngle - startAngle <= 180 ? '0' : '1';

    return [
      'M', outerStart.x, outerStart.y,
      'A', outerRadius, outerRadius, 0, largeArcFlag, 0, outerEnd.x, outerEnd.y,
      'L', innerStart.x, innerStart.y,
      'A', innerRadius, innerRadius, 0, largeArcFlag, 1, innerEnd.x, innerEnd.y,
      'Z'
    ].join(' ');
  }

  function getCategoryColor(category) {
    const colors = {
      PRICE_LIST: '#f97316',
      UOM_CONVERSION: '#0ea5a4',
      ITEM_XREF: '#dc2626',
      VALIDATION: '#eab308',
      ORDER_TYPE: '#2563eb',
      OTHER_ERROR: '#8b5cf6',
      UNKNOWN: '#64748b'
    };

    return colors[category] || '#475569';
  }

  function getCategoryGradientEndColor(category) {
    const colors = {
      PRICE_LIST: '#fb923c',
      UOM_CONVERSION: '#2dd4bf',
      ITEM_XREF: '#f87171',
      VALIDATION: '#fde047',
      ORDER_TYPE: '#60a5fa',
      OTHER_ERROR: '#c084fc',
      UNKNOWN: '#94a3b8'
    };

    return colors[category] || '#94a3b8';
  }

  function formatCategoryName(category) {
    const labels = {
      PRICE_LIST: 'Price List',
      UOM_CONVERSION: 'UOM Conversion',
      ITEM_XREF: 'Item Xref',
      VALIDATION: 'Validation',
      ORDER_TYPE: 'Order Type',
      OTHER_ERROR: 'Other Error',
      SUCCESS: 'Success',
      UNKNOWN: 'Unknown',
      None: 'None'
    };

    if (labels[category]) return labels[category];

    return String(category || 'None').replace(/_/g, ' ').toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
  }

  function buildTopActivityBars(items) {
    if (!items.length) return `<div class="empty-chart">No PO / TO activity for this date range.</div>`;

    const width = 500;
    const height = 360;
    const cx = 250;
    const cy = 154;
    const outerRadius = 92;
    const innerRadius = 62;
    const labelRadius = 142;
    const total = items.reduce((sum, item) => sum + Number(item.total || 0), 0);
    let angle = 0;

    const gradients = items.map((item, i) => `
      <linearGradient id="activityGradient${i}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${getActivityColor(i)}"></stop>
        <stop offset="100%" stop-color="${getActivityGradientEndColor(i)}"></stop>
      </linearGradient>`).join('');

    const slices = items.map((item, i) => {
      const value = Number(item.total || 0);
      const startAngle = angle;
      const endAngle = angle + ((value / Math.max(1, total)) * 360);
      const midAngle = startAngle + ((endAngle - startAngle) / 2);
      const label = formatOrderReferenceLabel(item.name);
      const detail = formatOrderReferenceType(item.name);
      const failed = Number(item.failed || 0);
      const success = Number(item.success || 0);
      const labelPoint = polarToCartesian(cx, cy, labelRadius, midAngle);
      const connectorStart = polarToCartesian(cx, cy, outerRadius + 10, midAngle);
      const connectorEnd = polarToCartesian(cx, cy, labelRadius - 20, midAngle);
      const textAnchor = labelPoint.x < cx - 8 ? 'end' : labelPoint.x > cx + 8 ? 'start' : 'middle';

      angle = endAngle;

      return `
        <path class="activity-slice" d="${describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle)}" fill="url(#activityGradient${i})" onclick="applySearch(${jsString(item.name)})">
          <title>${esc(label)}: ${value} total, ${failed} failed, ${success} success</title>
        </path>
        <line x1="${connectorStart.x}" y1="${connectorStart.y}" x2="${connectorEnd.x}" y2="${connectorEnd.y}" class="activity-connector"></line>
        <text x="${labelPoint.x}" y="${labelPoint.y - 4}" text-anchor="${textAnchor}" class="activity-circle-label">${esc(label)}</text>
        <text x="${labelPoint.x}" y="${labelPoint.y + 11}" text-anchor="${textAnchor}" class="activity-circle-count">${esc(detail)} · ${value}</text>`;
    }).join('');

    return `
<div class="activity-circle-wrap">
  <svg class="activity-circle-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Top PO TO activity distribution">
    <defs>
      <linearGradient id="activityPanelGradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#e0f7ff"></stop>
        <stop offset="52%" stop-color="#f0fdf4"></stop>
        <stop offset="100%" stop-color="#fff7ed"></stop>
      </linearGradient>
      <linearGradient id="activityWaveGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity=".18"></stop>
        <stop offset="50%" stop-color="#14b8a6" stop-opacity=".14"></stop>
        <stop offset="100%" stop-color="#f59e0b" stop-opacity=".18"></stop>
      </linearGradient>
      ${gradients}
    </defs>
    <rect x="0" y="0" width="${width}" height="${height}" rx="18" class="activity-chart-bg"></rect>
    <path d="M 0 270 C 100 250 174 288 270 264 C 356 242 426 250 500 232 L 500 360 L 0 360 Z" class="activity-chart-wave"></path>
    <circle cx="${cx}" cy="${cy}" r="${outerRadius + 13}" class="activity-orbit"></circle>
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 8}" class="activity-circle-center"></circle>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" class="activity-circle-total">${total}</text>
    <text x="${cx}" y="${cy + 16}" text-anchor="middle" class="activity-circle-sub">Responses</text>
  </svg>
  <div class="activity-circle-legend">
    ${items.map((item, i) => `
      <button type="button" class="activity-chip" onclick="applySearch(${jsString(item.name)})" title="Filter to ${escAttr(item.name)}">
        <span class="activity-chip-dot" style="background:linear-gradient(135deg,${getActivityColor(i)},${getActivityGradientEndColor(i)})"></span>
        <b>${esc(formatOrderReferenceLabel(item.name))}</b>
        <small>${Number(item.total || 0)}</small>
      </button>`).join('')}
  </div>
</div>`;
  }

  function getActivityColor(index) {
    const colors = ['#14b8a6', '#38bdf8', '#818cf8', '#db2777', '#f97316', '#f59e0b', '#84cc16', '#22c55e'];
    return colors[index % colors.length];
  }

  function getActivityGradientEndColor(index) {
    const colors = ['#5eead4', '#7dd3fc', '#a5b4fc', '#f472b6', '#fb923c', '#fbbf24', '#bef264', '#86efac'];
    return colors[index % colors.length];
  }

  function formatOrderReferenceLabel(value) {
    const text = String(value || '');
    const match = text.match(/#\s*([a-z]{1,5}\d+)/i) || text.match(/\b((?:to|po|so|wo)\d+)\b/i);

    if (match) return match[1].toUpperCase();

    return truncateText(text, 42);
  }

  function formatOrderReferenceType(value) {
    const text = String(value || '').toLowerCase();

    if (text.indexOf('transfer order') >= 0) return 'Transfer Order';
    if (text.indexOf('purchase order') >= 0) return 'Purchase Order';
    if (text.indexOf('sales order') >= 0) return 'Sales Order';
    if (text.indexOf('work order') >= 0) return 'Work Order';

    return 'Order Reference';
  }

  function buildStatusMix(summary) {
    const total = Number(summary.total || 0);
    const safeTotal = Math.max(1, total);
    const success = Number(summary.success || 0);
    const failed = Number(summary.failed || 0);
    const unknown = Number(summary.unknown || 0);
    const successPct = total ? Math.round((success / safeTotal) * 1000) / 10 : 0;
    const failedPct = total ? Math.round((failed / safeTotal) * 1000) / 10 : 0;
    const unknownPct = total ? Math.round((unknown / safeTotal) * 1000) / 10 : 0;
    const segments = [
      buildStatusMixSegment('success', 'SUCCESS', 'Success', success, successPct, 286, 148),
      buildStatusMixSegment('failed', 'FAILED', 'Failed', failed, failedPct, 176, 158),
      buildStatusMixSegment('unknown', 'UNKNOWN', 'Unknown', unknown, unknownPct, 226, 238)
    ];
    const outerCircles = segments.map(segment => `
      <circle class="mix-venn-outer ${escAttr(segment.className)}${segment.inactive ? ' inactive' : ''}" cx="${segment.x}" cy="${segment.y}" r="${segment.outerRadius}">
        <title>${esc(segment.label)}: ${esc(segment.value)} (${esc(formatRateValue(segment.pct))}%)</title>
      </circle>`).join('');
    const innerCircles = segments.slice().sort((a, b) => b.innerRadius - a.innerRadius).map(segment => {
      const statusClass = segment.inactive ? ' inactive' : '';
      const compactClass = segment.innerRadius < 56 ? ' compact' : '';

      return `
      <g class="mix-venn-bubble ${escAttr(segment.className)}${statusClass}${compactClass}" onclick="applyStatusFilter(${jsString(segment.status)})">
        <circle class="mix-venn-inner ${escAttr(segment.className)}" cx="${segment.x}" cy="${segment.y}" r="${segment.innerRadius}"></circle>
        <text x="${segment.x}" y="${segment.labelY}" text-anchor="middle" class="mix-venn-label">${esc(segment.label.toUpperCase())}</text>
        <text x="${segment.x}" y="${segment.valueY}" text-anchor="middle" class="mix-venn-value">${esc(segment.value)}</text>
        <text x="${segment.x}" y="${segment.pctY}" text-anchor="middle" class="mix-venn-pct">${esc(formatRateValue(segment.pct))}%</text>
      </g>`;
    }).join('');

    return `
<div class="mix-card">
  <div class="mix-venn-shell">
    <svg class="mix-venn-svg" viewBox="0 0 466 326" role="img" aria-label="Failure mix overlapping status circles">
      <defs>
        <linearGradient id="mixVennBackgroundGradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#f8fcff"></stop>
          <stop offset="46%" stop-color="#ecfeff"></stop>
          <stop offset="100%" stop-color="#fff7ed"></stop>
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="464" height="324" rx="12" class="mix-venn-bg"></rect>
      <g class="mix-total-badge">
        <rect x="326" y="20" width="118" height="42" rx="10"></rect>
        <text x="385" y="38" text-anchor="middle" class="mix-total-value">${esc(total)}</text>
        <text x="385" y="54" text-anchor="middle" class="mix-total-label">Responses</text>
      </g>
      ${outerCircles}
      ${innerCircles}
    </svg>
  </div>
  <div class="mix-venn-stats">
    ${segments.map(segment => `
      <button type="button" class="mix-venn-stat ${escAttr(segment.className)}" onclick="applyStatusFilter(${jsString(segment.status)})">
        <span class="mix-venn-stat-dot ${escAttr(segment.className)}"></span>
        <b>${esc(segment.label)}</b>
        <span>${esc(segment.value)}</span>
        <small>${esc(formatRateValue(segment.pct))}%</small>
      </button>`).join('')}
  </div>
</div>`;
  }

  function buildStatusMixSegment(className, status, label, value, pct, x, y) {
    const inactive = !Number(value || 0);
    const innerRadius = inactive ? 47 : getStatusMixWeightedRadius(pct);
    const outerRadius = innerRadius + (inactive ? 18 : 42);
    const labelOffset = innerRadius < 56 ? 16 : innerRadius > 82 ? 26 : 20;
    const valueOffset = innerRadius < 56 ? 8 : innerRadius > 82 ? 16 : 12;
    const pctOffset = innerRadius < 56 ? 26 : innerRadius > 82 ? 42 : 34;

    return {
      className,
      status,
      label,
      value,
      pct,
      x,
      y,
      inactive,
      innerRadius,
      outerRadius,
      labelY: y - labelOffset,
      valueY: y + valueOffset,
      pctY: y + pctOffset
    };
  }

  function getStatusMixWeightedRadius(pct) {
    const minRadius = 44;
    const maxRadius = 92;
    const normalizedPct = Math.max(0, Math.min(100, Number(pct || 0)));

    return Math.round(minRadius + (Math.sqrt(normalizedPct / 100) * (maxRadius - minRadius)));
  }

  function buildDrilldownCountText(total, filters) {
    const recordCount = Number(total || 0);
    const label = getDrilldownRecordLabel(filters);
    if (!recordCount) return '0 ' + label + ' shown';

    const shown = Math.min(recordCount, CONFIG.drilldownPageSize);
    return shown + ' of ' + recordCount + ' ' + label + ' shown';
  }

  function buildDrilldownPagerHtml(total, filters) {
    if (Number(total || 0) <= CONFIG.drilldownPageSize) return '';

    const label = getDrilldownRecordLabel(filters);
    return `
<div class="drilldown-pager">
  <span id="drilldownPagerText">Showing ${CONFIG.drilldownPageSize} of ${Number(total || 0)} ${esc(label)}</span>
  <button type="button" id="loadMoreDrilldown" class="btn drilldown-load-btn" onclick="loadNextDrilldownRows()">Load Next ${CONFIG.drilldownPageSize}</button>
</div>`;
  }

  function buildTableHtml(rows, filters) {
    return `
<div class="table-scroll">
  <table class="result-table" id="drilldownTable">
    <thead>
      <tr>
        <th><button type="button" class="sort-btn" onclick="sortTable(0,'number')">ID <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(1,'text')">Name <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(2,'number')">Created <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(3,'text')">Status <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(4,'number')">Severity <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(5,'number')">Priority <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(6,'text')">Category <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(7,'text')">Fingerprint <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(8,'text')">PO / TO <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(9,'text')">Sanmina Order <span>sort</span></button></th>
        <th><button type="button" class="sort-btn" onclick="sortTable(10,'text')">Message <span>sort</span></button></th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length ? rows.map((row, index) => buildTableRowHtml(row, index)).join('') : `<tr><td colspan="12" class="empty-row">No integration records found for the selected filters. Widen the date range or clear status/search filters to inspect older responses.</td></tr>`}
    </tbody>
  </table>
</div>
${buildDrilldownPagerHtml(rows.length, filters)}`;
  }

  function buildTableRowHtml(r, index) {
    const messageId = 'msg_' + safeDomId(r.id);
    const hasLongMessage = String(r.returnMessage || '').length > 110;
    const createdDate = parseNsDateTime(r.created);
    const createdSortValue = createdDate ? createdDate.getTime() : 0;
    const categoryLabel = formatCategoryName(r.category);
    const rowIndex = Number(index || 0);
    const hiddenStyle = rowIndex >= CONFIG.drilldownPageSize ? ' style="display:none"' : '';

    return `
<tr data-drilldown-index="${rowIndex}"${hiddenStyle}>
  <td data-sort-value="${escAttr(Number(r.id || 0))}">${buildRecordLink(r.id, r.recordUrl)}</td>
  <td data-sort-value="${escAttr(r.name)}">${buildRecordLink(r.name, r.recordUrl)}</td>
  <td data-sort-value="${createdSortValue}">${esc(r.created)}</td>
  <td data-sort-value="${escAttr(r.status)}">${buildStatusPill(r.status)}${r.resolvedBySuccess ? '<div class="row-note">Resolved by newer success</div>' : ''}</td>
  <td data-sort-value="${getSeverityRank(r.severity)}">${buildSeverityPill(r.severity)}</td>
  <td data-sort-value="${escAttr(String(r.priority || 'P4').replace(/\D/g, ''))}">${buildPriorityPill(r.priority)}</td>
  <td data-sort-value="${escAttr(categoryLabel)}">${esc(categoryLabel)}</td>
  <td data-sort-value="${escAttr(r.failureFingerprint)}">${esc(truncateText(r.failureFingerprint, 58))}</td>
  <td data-sort-value="${escAttr(r.purchaseOrder)}">${buildSearchLink(r.purchaseOrder)}</td>
  <td data-sort-value="${escAttr(r.sanminaOrderNumber)}">${esc(r.sanminaOrderNumber)}</td>
  <td data-sort-value="${escAttr(r.returnMessage)}">
    <div>${esc(truncateText(r.returnMessage, 110))}</div>
    ${hasLongMessage ? `<button type="button" class="message-btn" onclick="openMessageModal('${escAttr(messageId)}')">Full message</button>` : ''}
    <div id="${escAttr(messageId)}" class="message-source">${esc(r.returnMessage)}</div>
  </td>
  <td>${buildRetryAction(r)}</td>
</tr>`;
  }

  function buildRecordLink(text, href) {
    if (!text) return '';
    if (!href) return esc(text);

    return `<a class="table-link" href="${escAttr(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  }

  function buildSearchLink(text) {
    if (!text) return '';

    return `<button type="button" class="table-link link-button" onclick="applySearch(${jsString(text)})" title="Filter by ${escAttr(text)}">${esc(text)}</button>`;
  }

  function buildRetryAction(r) {
    if (!r.retryable) return '';

    if (!CONFIG.enableRetry) {
      return '<span class="retry-note" title="Retry is disabled until retry request fields are configured.">Retry off</span>';
    }

    if (!r.retryUrl) {
      return '<span class="retry-note" title="Could not resolve the transaction internal ID needed for ordID.">No ordID</span>';
    }

    return `<a class="mini-btn retry-link" href="${escAttr(r.retryUrl)}" target="_blank" rel="noopener">Retry</a>`;
  }

  function buildStatusPill(status) {
    const cls = status === 'SUCCESS' ? 'success' : status === 'FAILED' ? 'failed' : 'unknown';
    return `<span class="status-pill ${cls}">${esc(status)}</span>`;
  }

  function buildSeverityPill(severity) {
    const cls = String(severity || 'Low').toLowerCase();
    return `<span class="severity-pill ${escAttr(cls)}">${esc(severity || 'Low')}</span>`;
  }

  function buildPriorityPill(priority) {
    const cls = String(priority || 'P4').toLowerCase();
    return `<span class="priority-pill ${escAttr(cls)}">${esc(priority || 'P4')}</span>`;
  }

  function buildScript(suiteletUrl, filters) {
    const defaults = getDefaultDateRange();
    const defaultRecordType = getConfiguredRecordTypeInfo({}).recordType || CONFIG.recordType || '';
    const retryEnabled = CONFIG.enableRetry;
    return `
<script>
  var SUITELET_URL = ${JSON.stringify(suiteletUrl)};
  var DEFAULT_FROM = ${JSON.stringify(defaults.dateFrom)};
  var DEFAULT_TO = ${JSON.stringify(defaults.dateTo)};
  var DEFAULT_RECORD_TYPE = ${JSON.stringify(defaultRecordType)};
  var RETRY_ENABLED = ${JSON.stringify(retryEnabled)};
  var DRILLDOWN_PAGE_SIZE = ${JSON.stringify(CONFIG.drilldownPageSize)};
  var DRILLDOWN_RECORD_LABEL = ${JSON.stringify(getDrilldownRecordLabel(filters))};
  var drilldownVisibleCount = DRILLDOWN_PAGE_SIZE;
  var AUTO_REFRESH_ENABLED_KEY = 'psiqIntegrationDashboardAutoRefreshEnabled';
  var AUTO_REFRESH_INTERVAL_KEY = 'psiqIntegrationDashboardAutoRefreshIntervalSeconds';
  var AUTO_REFRESH_DEFAULT_SECONDS = 300;
  var autoRefreshTimeout = null;
  var autoRefreshCountdownTimer = null;
  var autoRefreshTargetTime = 0;
  var autoRefreshEnabled = false;

  function applyFilters(forceDefaultTo){
    var dateToInput = document.getElementById('dateTo');

    if(forceDefaultTo && dateToInput){
      dateToInput.value = getTodayInputDate();
    }

    var params = new URLSearchParams({
      dateFrom: document.getElementById('dateFrom').value,
      dateTo: dateToInput ? dateToInput.value : DEFAULT_TO,
      viewMode: document.getElementById('viewMode').value,
      status: document.getElementById('statusFilter').value,
      category: document.getElementById('categoryFilter').value,
      search: document.getElementById('globalSearch').value,
      recordType: document.getElementById('recordType').value
    });
    window.location.href = SUITELET_URL + (SUITELET_URL.indexOf('?') >= 0 ? '&' : '?') + params.toString();
  }

  function initializeAutoRefresh(){
    var intervalSelect = document.getElementById('autoRefreshInterval');
    var intervalSeconds = getAutoRefreshIntervalSeconds();

    if(intervalSelect){
      intervalSelect.value = String(intervalSeconds);
    }

    setAutoRefreshEnabled(safeLocalStorageGet(AUTO_REFRESH_ENABLED_KEY, 'F') === 'T', true);
  }

  function toggleAutoRefresh(){
    setAutoRefreshEnabled(!getStoredAutoRefreshEnabled(), false);
  }

  function setAutoRefreshEnabled(enabled, skipStore){
    autoRefreshEnabled = !!enabled;

    if(!skipStore){
      safeLocalStorageSet(AUTO_REFRESH_ENABLED_KEY, autoRefreshEnabled ? 'T' : 'F');
    }

    updateAutoRefreshUi(autoRefreshEnabled);

    if(autoRefreshEnabled){
      startAutoRefreshTimer();
    } else {
      stopAutoRefreshTimer();
      updateAutoRefreshStatus();
    }
  }

  function setAutoRefreshInterval(value){
    var seconds = normalizeAutoRefreshInterval(value);
    var intervalSelect = document.getElementById('autoRefreshInterval');

    if(intervalSelect){
      intervalSelect.value = String(seconds);
    }

    safeLocalStorageSet(AUTO_REFRESH_INTERVAL_KEY, String(seconds));

    if(getStoredAutoRefreshEnabled()){
      startAutoRefreshTimer();
    }
  }

  function startAutoRefreshTimer(){
    var seconds = getAutoRefreshIntervalSeconds();

    stopAutoRefreshTimer();
    autoRefreshTargetTime = new Date().getTime() + (seconds * 1000);
    autoRefreshTimeout = window.setTimeout(function(){
      applyFilters(true);
    }, seconds * 1000);
    autoRefreshCountdownTimer = window.setInterval(updateAutoRefreshStatus, 1000);
    updateAutoRefreshStatus();
  }

  function stopAutoRefreshTimer(){
    if(autoRefreshTimeout){
      window.clearTimeout(autoRefreshTimeout);
      autoRefreshTimeout = null;
    }

    if(autoRefreshCountdownTimer){
      window.clearInterval(autoRefreshCountdownTimer);
      autoRefreshCountdownTimer = null;
    }

    autoRefreshTargetTime = 0;
  }

  function updateAutoRefreshUi(enabled){
    var toggle = document.getElementById('autoRefreshToggle');

    if(!toggle) return;

    toggle.textContent = enabled ? 'Auto Refresh On' : 'Auto Refresh Off';
    if(enabled) toggle.className = 'btn auto-refresh-on';
    else toggle.className = 'btn';
  }

  function updateAutoRefreshStatus(){
    var status = document.getElementById('autoRefreshStatus');
    var enabled = getStoredAutoRefreshEnabled();

    if(!status) return;

    if(!enabled || !autoRefreshTargetTime){
      status.textContent = 'Auto refresh off';
      return;
    }

    var remaining = Math.max(0, Math.ceil((autoRefreshTargetTime - new Date().getTime()) / 1000));
    status.textContent = 'Auto refresh in ' + formatAutoRefreshCountdown(remaining);
  }

  function getStoredAutoRefreshEnabled(){
    return autoRefreshEnabled;
  }

  function getAutoRefreshIntervalSeconds(){
    return normalizeAutoRefreshInterval(safeLocalStorageGet(AUTO_REFRESH_INTERVAL_KEY, String(AUTO_REFRESH_DEFAULT_SECONDS)));
  }

  function normalizeAutoRefreshInterval(value){
    var seconds = Number(value || AUTO_REFRESH_DEFAULT_SECONDS);
    var allowed = [60, 300, 900];

    return allowed.indexOf(seconds) >= 0 ? seconds : AUTO_REFRESH_DEFAULT_SECONDS;
  }

  function formatAutoRefreshCountdown(seconds){
    var minutes = Math.floor(Number(seconds || 0) / 60);
    var remainder = Number(seconds || 0) % 60;

    return minutes + ':' + String(remainder).padStart(2, '0');
  }

  function safeLocalStorageGet(key, fallback){
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function safeLocalStorageSet(key, value){
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // Ignore storage failures and keep the control usable for this page load.
    }
  }

  function resetDefaultRange(){
    document.getElementById('dateFrom').value = DEFAULT_FROM;
    document.getElementById('dateTo').value = getTodayInputDate();
    document.getElementById('statusFilter').value = 'ALL';
    document.getElementById('categoryFilter').value = 'ALL';
    document.getElementById('globalSearch').value = '';
    document.getElementById('recordType').value = DEFAULT_RECORD_TYPE;
    document.getElementById('viewMode').value = 'CURRENT';
    applyFilters();
  }

  function setViewMode(mode){
    document.getElementById('viewMode').value = mode === 'HISTORY' ? 'HISTORY' : 'CURRENT';
    applyFilters();
  }

  function setDatePreset(preset){
    var end = parseInputDate(getTodayInputDate());
    var start = new Date(end);

    if(preset === 'YTD'){
      start = new Date(end.getFullYear(), 0, 1);
    } else if(preset === 'ALL'){
      start = new Date(2000, 0, 1);
    } else {
      start.setDate(end.getDate() - Number(preset || 7) + 1);
    }

    document.getElementById('dateFrom').value = formatInputDate(start);
    document.getElementById('dateTo').value = formatInputDate(end);
    applyFilters();
  }

  function parseInputDate(value){
    var parts = String(value || '').split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  function formatInputDate(dateObj){
    return [
      dateObj.getFullYear(),
      String(dateObj.getMonth() + 1).padStart(2, '0'),
      String(dateObj.getDate()).padStart(2, '0')
    ].join('-');
  }

  function getTodayInputDate(){
    return formatInputDate(new Date());
  }

  function useRecordType(recordType){
    document.getElementById('recordType').value = recordType || '';
    applyFilters();
  }

  function applyCategoryFilter(category){
    document.getElementById('statusFilter').value = 'FAILED';
    document.getElementById('categoryFilter').value = category || 'ALL';
    applyFilters();
  }

  function applySearch(value){
    document.getElementById('globalSearch').value = value || '';
    applyFilters();
  }

  function applyStatusFilter(status){
    document.getElementById('statusFilter').value = status || 'ALL';
    document.getElementById('categoryFilter').value = 'ALL';
    applyFilters();
  }

  function applyTrendFilter(status, dateFrom, dateTo){
    document.getElementById('dateFrom').value = dateFrom || DEFAULT_FROM;
    document.getElementById('dateTo').value = dateTo || DEFAULT_TO;
    document.getElementById('statusFilter').value = status || 'ALL';
    document.getElementById('categoryFilter').value = 'ALL';
    document.getElementById('globalSearch').value = '';
    applyFilters();
  }

  function clearResultFilters(){
    document.getElementById('statusFilter').value = 'ALL';
    document.getElementById('categoryFilter').value = 'ALL';
    applyFilters();
  }

  function getDrilldownRows(){
    var table = document.getElementById('drilldownTable');
    if(!table || !table.tBodies.length) return [];

    return Array.prototype.slice.call(table.tBodies[0].rows).filter(function(row){
      return row.getAttribute('data-drilldown-index') !== null;
    });
  }

  function initializeDrilldownPaging(){
    var rows = getDrilldownRows();
    drilldownVisibleCount = Math.min(DRILLDOWN_PAGE_SIZE, rows.length);
    updateDrilldownRowVisibility();
  }

  function updateDrilldownRowVisibility(){
    var rows = getDrilldownRows();
    drilldownVisibleCount = Math.min(drilldownVisibleCount, rows.length);

    rows.forEach(function(row, index){
      row.style.display = index < drilldownVisibleCount ? '' : 'none';
    });

    var countText = document.getElementById('drilldownCount');
    if(countText){
      countText.textContent = rows.length ? drilldownVisibleCount + ' of ' + rows.length + ' ' + DRILLDOWN_RECORD_LABEL + ' shown' : '0 ' + DRILLDOWN_RECORD_LABEL + ' shown';
    }

    var pagerText = document.getElementById('drilldownPagerText');
    if(pagerText){
      pagerText.textContent = 'Showing ' + drilldownVisibleCount + ' of ' + rows.length + ' ' + DRILLDOWN_RECORD_LABEL;
    }

    var loadButton = document.getElementById('loadMoreDrilldown');
    if(loadButton){
      var remaining = Math.max(0, rows.length - drilldownVisibleCount);
      loadButton.style.display = remaining > 0 ? '' : 'none';
      loadButton.textContent = 'Load Next ' + Math.min(DRILLDOWN_PAGE_SIZE, remaining);
    }
  }

  function loadNextDrilldownRows(){
    var rows = getDrilldownRows();
    drilldownVisibleCount = Math.min(rows.length, drilldownVisibleCount + DRILLDOWN_PAGE_SIZE);
    updateDrilldownRowVisibility();
  }

  var tableSortState = {};
  function sortTable(columnIndex, type){
    var table = document.getElementById('drilldownTable');
    if(!table || !table.tBodies.length) return;

    var tbody = table.tBodies[0];
    var rows = getDrilldownRows();
    var stateKey = String(columnIndex);
    var direction = tableSortState[stateKey] === 'asc' ? 'desc' : 'asc';

    tableSortState = {};
    tableSortState[stateKey] = direction;

    rows.sort(function(a, b){
      var aValue = getTableSortValue(a, columnIndex, type);
      var bValue = getTableSortValue(b, columnIndex, type);

      if(aValue < bValue) return direction === 'asc' ? -1 : 1;
      if(aValue > bValue) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    rows.forEach(function(row){
      tbody.appendChild(row);
    });

    updateDrilldownRowVisibility();
  }

  function getTableSortValue(row, columnIndex, type){
    var cell = row.cells[columnIndex];
    var raw = cell ? (cell.getAttribute('data-sort-value') || cell.textContent || '') : '';

    if(type === 'number'){
      return Number(raw) || 0;
    }

    return String(raw).toLowerCase();
  }

  function openMessageModal(sourceId){
    var source = document.getElementById(sourceId);
    var modal = document.getElementById('messageModal');
    var body = document.getElementById('messageModalBody');

    if(!modal || !body) return;

    body.textContent = source ? source.textContent : '';
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }

  function closeMessageModal(){
    var modal = document.getElementById('messageModal');

    if(!modal) return;

    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }

  function retryRecord(id){
    if(!RETRY_ENABLED){
      alert('Retry is disabled until retry request fields are configured.');
      return;
    }

    if(!confirm('Request retry for response record ' + id + '?')) return;

    var recordTypeField = document.getElementById('recordType');
    var recordType = recordTypeField ? recordTypeField.value : DEFAULT_RECORD_TYPE;
    var retryParams = new URLSearchParams({
      action: 'retry',
      id: id,
      recordType: recordType || DEFAULT_RECORD_TYPE
    });

    fetch(SUITELET_URL + (SUITELET_URL.indexOf('?') >= 0 ? '&' : '?') + retryParams.toString())
      .then(function(res){ return res.json(); })
      .then(function(data){
        alert(data.message || (data.ok ? 'Retry requested.' : 'Retry request failed.'));
        if(data.ok) applyFilters(true);
      })
      .catch(function(e){ alert(e.message || String(e)); });
  }

  function updateLastRefreshed(){
    var node = document.getElementById('lastRefreshed');
    if(!node) return;

    var value = node.getAttribute('data-generated-at');
    if(!value) return;

    var refreshedAt = new Date(value);
    if(isNaN(refreshedAt.getTime())) return;

    node.textContent = 'Last refreshed: ' + formatClientDateTime(refreshedAt);
  }

  function formatClientDateTime(dateObj){
    var hours = dateObj.getHours();
    var suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return [
      dateObj.getMonth() + 1,
      dateObj.getDate(),
      dateObj.getFullYear()
    ].join('/') + ' ' + hours + ':' + String(dateObj.getMinutes()).padStart(2, '0') + ' ' + suffix;
  }

  var searchInput = document.getElementById('globalSearch');
  if(searchInput){
    searchInput.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){
        e.preventDefault();
        applyFilters();
      }
    });
  }

  var messageModal = document.getElementById('messageModal');
  if(messageModal){
    messageModal.addEventListener('click', function(e){
      if(e.target === messageModal) closeMessageModal();
    });
  }

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeMessageModal();
  });

  updateLastRefreshed();
  initializeDrilldownPaging();
  initializeAutoRefresh();
</script>`;
  }

  function buildCss() {
    return `
<style>
.dash{font-family:Arial,sans-serif;background:linear-gradient(180deg,#f8fafc 0%,#eef3f8 100%);color:#1f2937;padding:16px}
.dash-topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}
.dash h1{font-size:24px;line-height:1.2;margin:0;color:#111827;font-weight:800}
.dash-sub{color:#64748b;margin-top:4px;font-size:13px}
.dash-topbar-right{display:flex;flex-direction:column;align-items:flex-end;gap:7px}
.dash-refresh{color:#64748b;font-size:12px;font-weight:800;white-space:nowrap}
.dash-actions{display:flex;gap:8px;align-items:center}
.btn,.mini-btn{display:inline-block;border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:4px;padding:9px 13px;font-weight:700;cursor:pointer;text-decoration:none}
.btn-primary{background:linear-gradient(135deg,#2563eb,#0ea5e9);border-color:#2563eb;color:#fff}
.auto-refresh-on{background:#ecfeff;border-color:#14b8a6;color:#0f766e}
.auto-refresh-select{height:36px;border:1px solid #d1d5db;background:#fff;color:#111827;border-radius:4px;padding:0 8px;font-size:12px;font-weight:800}
.auto-refresh-status{color:#64748b;font-size:11px;font-weight:800;white-space:nowrap}
.mini-btn{padding:5px 9px;font-size:12px}
.preset-row{display:flex;gap:8px;align-items:center;margin:-2px 0 10px;flex-wrap:wrap}
.preset-btn{border:1px solid #cbd5e1;background:#fff;color:#334155;border-radius:4px;padding:6px 10px;font-size:12px;font-weight:800;cursor:pointer}
.preset-btn:hover{background:#eff6ff;border-color:#93c5fd;color:#1d4ed8}
.preset-btn.active{background:linear-gradient(135deg,#2563eb,#0ea5e9);border-color:#2563eb;color:#fff;box-shadow:0 4px 10px rgba(37,99,235,.18)}
.error-banner{border:1px solid #fecaca;background:#fff1f2;color:#991b1b;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-weight:700}
.warning-banner{border:1px solid #fde68a;background:#fffbeb;color:#92400e;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-weight:800}
.source-help{background:#fff;border:1px solid #dbeafe;border-left:4px solid #2563eb;border-radius:4px;padding:14px;margin-bottom:14px;box-shadow:0 1px 4px rgba(15,23,42,.08)}
.source-help h2{font-size:15px;margin:0 0 4px 0;color:#111827;font-weight:800}
.source-help p{margin:0;color:#475569;font-size:13px}.source-help code{font-family:monospace;background:#eff6ff;color:#1d4ed8;padding:2px 4px;border-radius:3px}
.candidate-title{font-size:12px;color:#64748b;font-weight:800;margin:12px 0 8px;text-transform:uppercase}
.candidate-list{display:flex;flex-direction:column;gap:7px}.candidate-btn{text-align:left;border:1px solid #cbd5e1;background:#f8fafc;border-radius:4px;padding:8px 10px;cursor:pointer}
.candidate-btn:hover{background:#eff6ff;border-color:#93c5fd}.candidate-btn b{display:block;color:#0f172a;font-size:12px}.candidate-btn span{display:block;color:#64748b;font-size:11px;margin-top:2px}
.candidate-empty{margin-top:10px;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:4px;color:#64748b;padding:10px;font-weight:700}
.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;background:#fff;border:1px solid #e5e7eb;border-radius:4px;padding:14px;margin-bottom:14px;box-shadow:0 1px 4px rgba(15,23,42,.08)}
.filters label{display:block;font-size:12px;color:#475569;font-weight:700}
.filters input,.filters select{display:block;width:100%;height:34px;box-sizing:border-box;margin-top:5px;border:1px solid #cbd5e1;border-radius:3px;padding:5px 8px;font-size:14px;background:#fff}
.mode-toggle{display:grid;grid-template-columns:1fr 1fr;margin-top:5px;border:1px solid #cbd5e1;border-radius:4px;overflow:hidden;height:34px;background:#fff}
.mode-btn{border:0;background:#fff;color:#334155;font:inherit;font-size:12px;font-weight:800;cursor:pointer}
.mode-btn+.mode-btn{border-left:1px solid #cbd5e1}.mode-btn.active{background:linear-gradient(135deg,#2563eb,#0ea5e9);color:#fff}.mode-btn:hover:not(.active){background:#eff6ff;color:#1d4ed8}
.kpi-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:12px;margin-bottom:14px}
.kpi-card{appearance:none;text-align:left;width:100%;font:inherit;cursor:pointer;background:linear-gradient(135deg,#ffffff 0%,#f8fafc 48%,#eef2ff 100%);border:1px solid #e5e7eb;border-left:4px solid #64748b;border-radius:4px;padding:14px;box-shadow:0 1px 4px rgba(15,23,42,.08);min-height:82px}
.kpi-card:hover{border-color:#93c5fd;box-shadow:0 4px 12px rgba(15,23,42,.12)}
.kpi-card.good{border-left-color:#0f9f8e;background:linear-gradient(135deg,#ffffff 0%,#ecfeff 58%,#ccfbf1 100%)}.kpi-card.bad{border-left-color:#f97316;background:linear-gradient(135deg,#ffffff 0%,#fff7ed 58%,#fed7aa 100%)}.kpi-card.neutral{border-left-color:#94a3b8}.kpi-card.wide{border-left-color:#2563eb;background:linear-gradient(135deg,#ffffff 0%,#eff6ff 58%,#dbeafe 100%)}
.kpi-label{font-size:11px;text-transform:uppercase;color:#64748b;font-weight:800;letter-spacing:.04em}
.kpi-value{font-size:28px;color:#111827;font-weight:800;margin-top:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-card.wide .kpi-value{font-size:18px}
.kpi-delta{font-size:12px;font-weight:800;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpi-delta.good{color:#047857}.kpi-delta.bad{color:#b45309}.kpi-delta.neutral{color:#64748b}
.insight-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:14px}
.insight-card{background:linear-gradient(135deg,#ffffff 0%,#f8fafc 52%,#eef2ff 100%);border:1px solid #e5e7eb;border-radius:4px;padding:12px 14px;box-shadow:0 1px 4px rgba(15,23,42,.08);min-height:74px}
.insight-label{font-size:11px;color:#64748b;text-transform:uppercase;font-weight:800;letter-spacing:.04em}
.insight-value{font-size:16px;color:#111827;font-weight:800;margin-top:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.insight-detail{color:#64748b;font-size:12px;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.analysis-grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-bottom:14px}
.analysis-grid.lower{grid-template-columns:1fr 1fr}
.panel{background:#fff;border:1px solid #e5e7eb;border-radius:4px;box-shadow:0 1px 4px rgba(15,23,42,.08);padding:14px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px}
.panel h2{font-size:14px;margin:0;color:#111827;font-weight:800}
.panel-head span{display:block;font-size:12px;color:#64748b;margin-top:2px}
.trend-panel{background:linear-gradient(135deg,#ffffff 0%,#f8fcff 56%,#eef9ff 100%)}
.chart-wrap svg{display:block;width:100%;height:auto;min-height:320px;overflow:visible}
.trend-chart-wrap svg{filter:drop-shadow(0 6px 14px rgba(14,165,233,.08))}
.trend-chart-bg{fill:url(#trendBackgroundGradient);stroke:#dbeafe;stroke-width:1}
.trend-chart-wave{fill:url(#trendWaveGradient)}
.grid-line{stroke:#d7e8f4;stroke-width:1}.axis-line{stroke:#8aa3bd;stroke-width:1.2}.axis-label{font-size:10px;fill:#64748b}.bar-value-label{font-size:10px;fill:#111827;font-weight:800;pointer-events:none}
.trend-bar-clickable{cursor:pointer}.trend-bar-clickable:hover{opacity:.82}
.trend-overlay{pointer-events:none}.trend-overlay-line{fill:none;stroke-width:2.8;stroke-linecap:round;stroke-linejoin:round}.trend-overlay-line.success{stroke:#0f9f8e;filter:drop-shadow(0 1px 3px rgba(20,184,166,.28))}.trend-overlay-line.failed{stroke:#f97316;filter:drop-shadow(0 1px 3px rgba(249,115,22,.30))}.trend-overlay-line.unknown{stroke:#64748b;filter:drop-shadow(0 1px 3px rgba(100,116,139,.24))}.trend-overlay-point{fill:#fff;stroke-width:2.2}.trend-overlay-point.success{stroke:#0f9f8e}.trend-overlay-point.failed{stroke:#f97316}.trend-overlay-point.unknown{stroke:#64748b}
.legend{display:flex;gap:14px;justify-content:center;align-items:center;color:#64748b;font-size:12px;margin-top:4px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}.dot.good{background:#0f9f8e}.dot.bad{background:#f97316}.dot.neutral{background:#94a3b8}
.trend-gauge-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.trend-gauge-card{position:relative;min-height:218px;border:1px solid #e5e7eb;border-radius:4px;background:#fff;color:#111827;padding:12px 16px 14px;box-shadow:0 1px 4px rgba(15,23,42,.08);overflow:hidden}
.trend-gauge-card:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 50% 16%,rgba(37,99,235,.06),transparent 44%);pointer-events:none}
.trend-gauge-svg{position:relative;display:block;width:100%;max-width:320px;height:auto;margin:0 auto -26px;overflow:visible}
.trend-gauge-track{fill:none;stroke:#e2e8f0;stroke-width:24;stroke-linecap:butt}
.trend-gauge-arc{fill:none;stroke-width:24;stroke-linecap:butt}
.trend-gauge-needle{fill:#fff;stroke:#334155;stroke-width:2;filter:drop-shadow(0 1px 2px rgba(15,23,42,.35))}
.trend-gauge-hub{fill:#fff;stroke:#334155;stroke-width:2}
.trend-gauge-value{position:relative;text-align:center;color:#111827;font-size:31px;line-height:1;font-weight:800;margin-top:-22px}
.trend-gauge-label{position:relative;text-align:center;color:#64748b;font-size:13px;font-weight:800;margin-top:9px}
.trend-gauge-stats{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:17px;text-align:center}
.trend-gauge-stats b{display:block;color:#64748b;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trend-gauge-stats span{display:block;color:#111827;font-size:12px;font-weight:800;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.category-circle-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;min-height:320px}
.category-panel{background:linear-gradient(135deg,#ffffff 0%,#fff7ed 42%,#ecfeff 100%)}
.category-circle-svg{display:block;width:100%;max-width:420px;height:auto;overflow:visible;filter:drop-shadow(0 8px 18px rgba(249,115,22,.08))}
.category-chart-bg{fill:url(#categoryPanelGradient);stroke:#fed7aa;stroke-width:1}
.category-chart-glow{fill:url(#categoryGlowGradient)}
.category-chart-wave{fill:url(#categoryWaveGradient)}
.category-orbit{fill:none;stroke:#e2e8f0;stroke-width:14;opacity:.7}
.category-slice{cursor:pointer;stroke:#fff;stroke-width:4;filter:drop-shadow(0 5px 8px rgba(15,23,42,.12))}
.category-slice:hover{opacity:.86}
.category-circle-center{fill:#fff;stroke:#e5e7eb;stroke-width:2;filter:drop-shadow(0 6px 12px rgba(15,23,42,.16))}
.category-circle-total{font-size:28px;fill:#111827;font-weight:800}
.category-circle-sub{font-size:11px;fill:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.category-circle-label{font-size:10px;fill:#334155;font-weight:800}
.category-circle-count{font-size:10px;fill:#64748b;font-weight:800}
.category-circle-legend{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:2px}
.category-chip{display:grid;grid-template-columns:12px 1fr auto;gap:7px;align-items:center;border:1px solid #e5e7eb;background:linear-gradient(135deg,#fff,#f8fafc);border-radius:4px;padding:7px 8px;cursor:pointer;text-align:left;font:inherit;min-width:0}
.category-chip:hover{border-color:#93c5fd;background:linear-gradient(135deg,#fff,#eff6ff)}
.category-chip-dot{width:10px;height:10px;border-radius:50%}
.category-chip b{font-size:11px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.category-chip small{font-size:11px;color:#111827;font-weight:800}
.activity-circle-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;min-height:320px}
.activity-panel{background:linear-gradient(135deg,#ffffff 0%,#f7fdff 54%,#f0fdf4 100%)}
.activity-circle-svg{display:block;width:100%;max-width:520px;height:auto;overflow:visible;filter:drop-shadow(0 8px 18px rgba(14,165,233,.08))}
.activity-chart-bg{fill:url(#activityPanelGradient);stroke:#dbeafe;stroke-width:1}
.activity-chart-wave{fill:url(#activityWaveGradient)}
.activity-orbit{fill:none;stroke:#e2e8f0;stroke-width:14;opacity:.7}
.activity-slice{cursor:pointer;stroke:#fff;stroke-width:5;filter:drop-shadow(0 5px 8px rgba(15,23,42,.12))}
.activity-slice:hover{opacity:.86}
.activity-connector{stroke:#d1d5db;stroke-width:1}
.activity-circle-center{fill:#fff;stroke:#e5e7eb;stroke-width:2;filter:drop-shadow(0 6px 12px rgba(15,23,42,.16))}
.activity-circle-total{font-size:34px;fill:#111827;font-weight:800}
.activity-circle-sub{font-size:11px;fill:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.activity-circle-label{font-size:10px;fill:#334155;font-weight:800}
.activity-circle-count{font-size:10px;fill:#64748b;font-weight:800}
.activity-circle-legend{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:2px}
.activity-chip{display:grid;grid-template-columns:12px 1fr auto;gap:7px;align-items:center;border:1px solid #dbeafe;background:linear-gradient(135deg,#ffffff 0%,#f8fcff 56%,#eef9ff 100%);border-radius:4px;padding:7px 8px;cursor:pointer;text-align:left;font:inherit;min-width:0}
.activity-chip:hover{border-color:#93c5fd;background:linear-gradient(135deg,#ffffff,#ecfeff)}
.activity-chip-dot{width:10px;height:10px;border-radius:50%}
.activity-chip b{font-size:11px;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.activity-chip small{font-size:11px;color:#111827;font-weight:800}
.empty-chart{height:160px;display:flex;align-items:center;justify-content:center;color:#64748b;font-weight:700;background:#f8fafc;border:1px dashed #cbd5e1;border-radius:4px}
.mix-card{display:flex;flex-direction:column;align-items:stretch;padding:6px 2px 0}
.mix-panel{background:linear-gradient(135deg,#ffffff 0%,#f8fcff 48%,#fff7ed 100%)}
.mix-venn-shell{display:flex;justify-content:center;align-items:center;width:100%;min-height:292px}
.mix-venn-svg{display:block;width:100%;max-width:540px;height:auto;overflow:visible}
.mix-venn-bg{fill:url(#mixVennBackgroundGradient);stroke:#dbeafe;stroke-width:1}
.mix-total-badge rect{fill:#f8fafc;stroke:#dbeafe;stroke-width:1.2}
.mix-total-value{font-size:17px;fill:#111827;font-weight:800}
.mix-total-label{font-size:9px;fill:#64748b;font-weight:800;text-transform:uppercase;letter-spacing:.08em}
.mix-venn-outer{opacity:.44;mix-blend-mode:multiply}
.mix-venn-outer.failed{fill:#fde68a}
.mix-venn-outer.success{fill:#99f6e4}
.mix-venn-outer.unknown{fill:#bfdbfe}
.mix-venn-outer.inactive{fill:none;stroke:#bfdbfe;stroke-width:4;stroke-dasharray:9 8;opacity:.86;mix-blend-mode:normal}
.mix-venn-bubble{cursor:pointer}
.mix-venn-inner{filter:drop-shadow(0 8px 14px rgba(15,23,42,.12));transition:opacity .12s ease}
.mix-venn-inner.failed{fill:#fbbf24}
.mix-venn-inner.success{fill:#14b8a6}
.mix-venn-inner.unknown{fill:#38bdf8}
.mix-venn-bubble.inactive .mix-venn-inner{fill:#f8fcff;stroke:#38bdf8;stroke-width:3;stroke-dasharray:7 7;filter:none}
.mix-venn-bubble:hover .mix-venn-inner{opacity:.88}
.mix-venn-label{font-size:13px;fill:#fff;font-weight:800;letter-spacing:.05em}
.mix-venn-value{font-size:29px;fill:#fff;font-weight:800}
.mix-venn-pct{font-size:12px;fill:rgba(255,255,255,.9);font-weight:800}
.mix-venn-bubble.success .mix-venn-label{font-size:14px}.mix-venn-bubble.success .mix-venn-value{font-size:36px}.mix-venn-bubble.success .mix-venn-pct{font-size:14px}
.mix-venn-bubble.compact .mix-venn-label{font-size:10px}.mix-venn-bubble.compact .mix-venn-value{font-size:24px}.mix-venn-bubble.compact .mix-venn-pct{font-size:10px}
.mix-venn-bubble.inactive .mix-venn-label,.mix-venn-bubble.inactive .mix-venn-value,.mix-venn-bubble.inactive .mix-venn-pct{fill:#64748b;text-shadow:none}
.mix-venn-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;width:100%;margin-top:4px}
.mix-venn-stat{display:grid;grid-template-columns:10px 1fr auto;gap:7px;align-items:center;background:linear-gradient(135deg,#ffffff 0%,#f8fcff 62%,#eef9ff 100%);border:1px solid #dbeafe;border-radius:4px;padding:9px 10px;min-width:0;text-align:left;font:inherit;cursor:pointer}
.mix-venn-stat:hover{border-color:#93c5fd;background:#f8fcff}
.mix-venn-stat-dot{width:9px;height:9px;border-radius:50%}.mix-venn-stat-dot.success{background:#14b8a6}.mix-venn-stat-dot.failed{background:#fbbf24}.mix-venn-stat-dot.unknown{background:#38bdf8}
.mix-venn-stat b{font-size:11px;color:#334155;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mix-venn-stat span{font-size:13px;color:#111827;font-weight:800}
.mix-venn-stat small{grid-column:2 / span 2;color:#64748b;font-size:11px;font-weight:800}
.table-panel{padding-bottom:10px}
.table-scroll{overflow:auto;max-height:620px;border-top:1px solid #e5e7eb}
.drilldown-pager{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #e5e7eb;padding:10px 0 0;margin-top:10px;color:#64748b;font-size:12px;font-weight:800}
.drilldown-load-btn{padding:7px 11px;font-size:12px}
.result-table{width:100%;border-collapse:collapse;font-size:12px}
.result-table th{position:sticky;top:0;z-index:2;text-align:left;background:#f8fafc;color:#334155;border-bottom:1px solid #cbd5e1;padding:10px;font-weight:800;white-space:nowrap}
.sort-btn{border:0;background:transparent;color:#334155;font:inherit;font-weight:800;padding:0;cursor:pointer;text-align:left;white-space:nowrap}
.sort-btn span{font-size:10px;color:#94a3b8;font-weight:800;margin-left:4px;text-transform:uppercase}
.sort-btn:hover{color:#2563eb}.sort-btn:hover span{color:#2563eb}
.result-table td{border-bottom:1px solid #e5e7eb;padding:9px 10px;vertical-align:top;color:#1f2937}
.result-table tbody tr:nth-child(even) td{background:#fbfdff}
.result-table tr:hover td{background:#f8fafc}
.table-link{color:#2563eb;font-weight:800;text-decoration:none}
.table-link:hover{text-decoration:underline}
.link-button{border:0;background:transparent;padding:0;text-align:left;cursor:pointer;font:inherit}
.status-pill{display:inline-block;border-radius:999px;padding:4px 9px;font-weight:800;font-size:11px}
.status-pill.success{background:#ccfbf1;color:#115e59}.status-pill.failed{background:#ffedd5;color:#9a3412}.status-pill.unknown{background:#e2e8f0;color:#334155}
.row-note{color:#047857;font-size:10px;font-weight:800;margin-top:5px;white-space:nowrap}
.severity-pill,.priority-pill{display:inline-block;border-radius:999px;padding:4px 8px;font-weight:800;font-size:10px;white-space:nowrap}
.severity-pill.critical{background:#fee2e2;color:#991b1b}.severity-pill.high{background:#ffedd5;color:#9a3412}.severity-pill.medium{background:#fef9c3;color:#854d0e}.severity-pill.low{background:#dbeafe;color:#1d4ed8}.severity-pill.info{background:#ccfbf1;color:#115e59}
.priority-pill.p1{background:#991b1b;color:#fff}.priority-pill.p2{background:#f97316;color:#fff}.priority-pill.p3{background:#eab308;color:#422006}.priority-pill.p4{background:#e2e8f0;color:#334155}
.message-btn{border:0;background:transparent;color:#2563eb;font-weight:800;padding:5px 0 0;cursor:pointer}
.message-source{display:none}
.retry-note{display:inline-block;border:1px solid #e5e7eb;background:#f8fafc;color:#64748b;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:800;white-space:nowrap}
.retry-link{padding:5px 9px;font-size:12px}
.modal-backdrop{display:none;position:fixed;z-index:9999;inset:0;background:rgba(15,23,42,.42);align-items:center;justify-content:center;padding:20px}
.message-modal{background:#fff;border-radius:6px;box-shadow:0 18px 60px rgba(15,23,42,.30);width:min(780px,96vw);max-height:82vh;display:flex;flex-direction:column}
.message-modal-head{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e5e7eb;padding:12px 14px}
.message-modal h2{font-size:15px;margin:0;color:#111827}
.icon-btn{width:30px;height:30px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;color:#334155;font-weight:800;cursor:pointer}
.message-modal pre{white-space:pre-wrap;margin:0;padding:14px;overflow:auto;background:#f8fafc;color:#1f2937;font-size:13px;line-height:1.45;max-height:64vh}
.empty-row{text-align:center;color:#64748b;font-weight:800;padding:30px!important}
.dash-footer{display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:14px;padding:12px 2px 0;border-top:1px solid #e5e7eb;color:#64748b;font-size:12px;font-weight:700}.version-badge{background:#eef2ff;border:1px solid #dbeafe;color:#334155;border-radius:999px;padding:3px 8px;font-weight:800}
@media(max-width:1200px){.kpi-grid{grid-template-columns:repeat(3,1fr)}.insight-grid{grid-template-columns:repeat(2,1fr)}.analysis-grid,.analysis-grid.lower{grid-template-columns:1fr}}
@media(max-width:760px){.dash-topbar{align-items:flex-start;flex-direction:column}.dash-topbar-right{width:100%;align-items:flex-start}.filters{grid-template-columns:1fr}.kpi-grid,.insight-grid,.trend-gauge-grid{grid-template-columns:1fr}.dash-actions{width:100%;flex-direction:column;align-items:stretch}.btn,.auto-refresh-select{width:100%}.dash-footer{justify-content:flex-start}.drilldown-pager{align-items:stretch;flex-direction:column}.activity-circle-legend,.category-circle-legend,.mix-venn-stats{grid-template-columns:1fr}.mix-venn-shell{min-height:250px}}
</style>`;
  }

  function parseNsDateTime(value) {
    if (!value) return null;

    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    try {
      const parsedDateTime = format.parse({
        value: String(value),
        type: format.Type.DATETIME
      });

      if (parsedDateTime && !isNaN(parsedDateTime.getTime())) {
        return parsedDateTime;
      }
    } catch (e) {
      // Try date-only and native parsing below.
    }

    try {
      const parsedDate = format.parse({
        value: String(value),
        type: format.Type.DATE
      });

      if (parsedDate && !isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    } catch (e) {
      // Fall through to native Date parsing.
    }

    const nativeDate = new Date(value);
    return isNaN(nativeDate.getTime()) ? null : nativeDate;
  }

  function isoDateBoundary(isoDate, endOfDay) {
    const parts = String(isoDate || '').split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);

    if (endOfDay) {
      d.setHours(23, 59, 59, 999);
    }

    return d;
  }

  function getCreatedDateKey(value) {
    const createdDate = parseNsDateTime(value);
    if (createdDate) return toIsoDate(createdDate);
    return String(value || '').substring(0, 10) || 'Unknown';
  }

  function stripTime(dateObj) {
    return new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  }

  function getDateRangeDays(start, end) {
    const dayMs = 24 * 60 * 60 * 1000;
    return Math.max(1, Math.floor((stripTime(end).getTime() - stripTime(start).getTime()) / dayMs) + 1);
  }

  function getTrendGroupingLabel(filters) {
    const start = isoDateBoundary(filters.dateFrom, false);
    const end = isoDateBoundary(filters.dateTo, false);
    return getDateRangeDays(start, end) > 31 ? 'Grouped weekly' : 'Grouped daily';
  }

  function toIsoDate(dateObj) {
    return [
      dateObj.getFullYear(),
      pad2(dateObj.getMonth() + 1),
      pad2(dateObj.getDate())
    ].join('-');
  }

  function formatShortDate(dateObj) {
    return pad2(dateObj.getMonth() + 1) + '/' + pad2(dateObj.getDate());
  }

  function formatShortDateRange(startDate, endDate) {
    return formatShortDate(startDate) + '-' + formatShortDate(endDate);
  }

  function pad2(value) {
    return Number(value) < 10 ? '0' + Number(value) : String(value);
  }

  function isIsoDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function normalizeMatchText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9#]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function safeDomId(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function jsString(value) {
    return escAttr(JSON.stringify(String(value == null ? '' : value)));
  }

  function truncateText(value, maxLen) {
    const text = String(value || '');
    return text.length > maxLen ? text.substring(0, maxLen - 3) + '...' : text;
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#096;');
  }

  return { onRequest };
});
