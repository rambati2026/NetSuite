/**
 * NetSuite Suitelet: Vendor 360 Transaction Dashboard
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati 04/28/2026
 */
define(['N/ui/serverWidget', 'N/search', 'N/url', 'N/format', 'N/log'], (
  serverWidget,
  search,
  url,
  format,
  log
) => {
  const CONFIG = {
    title: 'Vendor 360 Transaction Dashboard',
    maxRows: 3000,
    defaultYearsBack: 3,
    tablePageSize: 100,
    transactionTypes: {
      PurchOrd: {
        label: 'Purchase Orders',
        shortLabel: 'POs',
        color: '#2563eb',
        colorEnd: '#60a5fa',
        recordType: 'purchaseorder'
      },
      VendBill: {
        label: 'Vendor Bills',
        shortLabel: 'Bills',
        color: '#f97316',
        colorEnd: '#fb923c',
        recordType: 'vendorbill'
      },
      ItemRcpt: {
        label: 'Item Receipts',
        shortLabel: 'Receipts',
        color: '#14b8a6',
        colorEnd: '#5eead4',
        recordType: 'itemreceipt'
      },
      VendPymt: {
        label: 'Vendor Payments',
        shortLabel: 'Payments',
        color: '#8b5cf6',
        colorEnd: '#c084fc',
        recordType: 'vendorpayment'
      },
      VendCred: {
        label: 'Vendor Credits',
        shortLabel: 'Credits',
        color: '#db2777',
        colorEnd: '#f472b6',
        recordType: 'vendorcredit'
      }
    }
  };

  function onRequest(context) {
    try {
      const request = context.request;
      const response = context.response;
      const filters = normalizeFilters(request.parameters || {});
      const form = buildForm(filters);
      const htmlField = form.addField({
        id: 'custpage_dashboard_html',
        type: serverWidget.FieldType.INLINEHTML,
        label: 'Dashboard'
      });
      htmlField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });
      htmlField.updateLayoutType({ layoutType: serverWidget.FieldLayoutType.OUTSIDEBELOW });

      const data = filters.vendorId ? buildDashboardData(filters) : buildEmptyDashboardData(filters);
      htmlField.defaultValue = buildHtml(data, filters);
      response.writePage(form);
    } catch (e) {
      log.error({
        title: 'Vendor 360 transaction dashboard failed',
        details: e
      });
      context.response.write(
        '<html><body style="font-family:Arial,sans-serif;padding:20px;">' +
        '<h2>Vendor 360 Transaction Dashboard Error</h2>' +
        '<pre>' + esc((e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : String(e))) + '</pre>' +
        '</body></html>'
      );
    }
  }

  function buildForm(filters) {
    const form = serverWidget.createForm({ title: CONFIG.title });

    const vendorField = form.addField({
      id: 'custpage_vendor',
      type: serverWidget.FieldType.SELECT,
      label: 'Vendor',
      source: 'vendor'
    });
    vendorField.isMandatory = true;
    if (filters.vendorId) vendorField.defaultValue = filters.vendorId;

    const typeField = form.addField({
      id: 'custpage_txntype',
      type: serverWidget.FieldType.SELECT,
      label: 'Transaction Type'
    });
    typeField.addSelectOption({ value: 'ALL', text: '- All -' });
    Object.keys(CONFIG.transactionTypes).forEach(type => {
      typeField.addSelectOption({ value: type, text: CONFIG.transactionTypes[type].label });
    });
    typeField.defaultValue = filters.transactionType;
    typeField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTCOL });

    const dateFromField = form.addField({
      id: 'custpage_datefrom',
      type: serverWidget.FieldType.DATE,
      label: 'From Date'
    });
    if (filters.dateFrom) dateFromField.defaultValue = filters.dateFrom;

    const dateToField = form.addField({
      id: 'custpage_dateto',
      type: serverWidget.FieldType.DATE,
      label: 'To Date'
    });
    if (filters.dateTo) dateToField.defaultValue = filters.dateTo;
    dateToField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTCOL });

    const searchField = form.addField({
      id: 'custpage_search',
      type: serverWidget.FieldType.TEXT,
      label: 'Search'
    });
    searchField.defaultValue = filters.searchText;

    const resetField = form.addField({
      id: 'custpage_reset',
      type: serverWidget.FieldType.TEXT,
      label: 'Reset Dashboard'
    });
    resetField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

    form.addSubmitButton({ label: 'Show Transactions' });
    form.addResetButton({ label: 'Reset' });

    return form;
  }

  function normalizeFilters(params) {
    const vendorId = String(params.custpage_vendor || params.vendor || '').trim();
    const submittedDateFrom = String(params.custpage_datefrom || params.datefrom || '').trim();
    const submittedDateTo = String(params.custpage_dateto || params.dateto || '').trim();
    const searchText = String(params.custpage_search || params.search || '').trim();
    const isReset = String(params.custpage_reset || params.reset || '') === 'T' &&
      !vendorId &&
      !submittedDateFrom &&
      !submittedDateTo &&
      !searchText;
    const transactionType = String(params.custpage_txntype || params.txntype || 'ALL');
    const defaultDates = getDefaultDateFilters();
    const hasSubmittedFilters =
      hasParam(params, 'custpage_vendor') ||
      hasParam(params, 'vendor') ||
      hasParam(params, 'custpage_txntype') ||
      hasParam(params, 'txntype') ||
      hasParam(params, 'custpage_datefrom') ||
      hasParam(params, 'datefrom') ||
      hasParam(params, 'custpage_dateto') ||
      hasParam(params, 'dateto') ||
      hasParam(params, 'custpage_search') ||
      hasParam(params, 'search');
    const dateFrom = hasParam(params, 'custpage_datefrom') || hasParam(params, 'datefrom') || hasSubmittedFilters ?
      submittedDateFrom :
      String(defaultDates.dateFrom || '').trim();
    const dateTo = hasParam(params, 'custpage_dateto') || hasParam(params, 'dateto') || hasSubmittedFilters ?
      submittedDateTo :
      String(defaultDates.dateTo || '').trim();

    if (isReset) {
      return {
        vendorId: '',
        transactionType: 'ALL',
        dateFrom: '',
        dateTo: '',
        searchText: ''
      };
    }

    return {
      vendorId,
      transactionType: CONFIG.transactionTypes[transactionType] ? transactionType : 'ALL',
      dateFrom,
      dateTo,
      searchText
    };
  }

  function hasParam(params, name) {
    return Object.prototype.hasOwnProperty.call(params || {}, name);
  }

  function getDefaultDateFilters() {
    const today = new Date();
    const from = new Date(today.getFullYear() - Number(CONFIG.defaultYearsBack || 3), today.getMonth(), today.getDate());

    return {
      dateFrom: formatDateForField(from),
      dateTo: formatDateForField(today)
    };
  }

  function formatDateForField(dateObj) {
    try {
      return format.format({
        value: dateObj,
        type: format.Type.DATE
      });
    } catch (e) {
      return (dateObj.getMonth() + 1) + '/' + dateObj.getDate() + '/' + dateObj.getFullYear();
    }
  }

  function buildEmptyDashboardData(filters) {
    return {
      generatedAt: new Date().toISOString(),
      vendorName: '',
      filters,
      rows: [],
      summary: buildSummary([]),
      typeBreakdown: buildTypeBreakdown([]),
      monthlyTrend: [],
      poMonthlyTrend: [],
      poStatusBreakdown: [],
      receiptDateBreakdown: [],
      billMonthlyTrend: [],
      latestTransactions: [],
      hitLimit: false
    };
  }

  function buildDashboardData(filters) {
    const rows = getVendorTransactions(filters);
    const vendorName = getVendorName(filters.vendorId);
    const metrics = buildDashboardMetrics(rows);

    return {
      generatedAt: new Date().toISOString(),
      vendorName,
      filters,
      rows,
      summary: metrics.summary,
      typeBreakdown: metrics.typeBreakdown,
      monthlyTrend: metrics.monthlyTrend,
      poMonthlyTrend: metrics.poMonthlyTrend,
      poStatusBreakdown: metrics.poStatusBreakdown,
      receiptDateBreakdown: metrics.receiptDateBreakdown,
      billMonthlyTrend: metrics.billMonthlyTrend,
      latestTransactions: metrics.latestTransactions,
      hitLimit: rows.length >= CONFIG.maxRows
    };
  }

  function getVendorTransactions(filters) {
    const typeValues = filters.transactionType === 'ALL' ?
      Object.keys(CONFIG.transactionTypes) :
      [filters.transactionType];
    const searchFilters = [
      ['mainline', 'is', 'T'],
      'AND',
      ['entity', 'anyof', filters.vendorId],
      'AND',
      ['type', 'anyof', typeValues]
    ];

    if (filters.dateFrom) {
      searchFilters.push('AND', ['trandate', 'onorafter', filters.dateFrom]);
    }

    if (filters.dateTo) {
      searchFilters.push('AND', ['trandate', 'onorbefore', filters.dateTo]);
    }

    const columns = {
      internalId: search.createColumn({ name: 'internalid' }),
      type: search.createColumn({ name: 'type' }),
      tranId: search.createColumn({ name: 'tranid' }),
      transactionNumber: search.createColumn({ name: 'transactionnumber' }),
      tranDate: search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
      status: search.createColumn({ name: 'statusref' }),
      amount: search.createColumn({ name: 'amount' }),
      fxAmount: search.createColumn({ name: 'fxamount' }),
      currency: search.createColumn({ name: 'currency' }),
      createdFrom: search.createColumn({ name: 'createdfrom' }),
      memo: search.createColumn({ name: 'memo' })
    };

    const txnSearch = search.create({
      type: search.Type.TRANSACTION,
      filters: searchFilters,
      columns: Object.keys(columns).map(key => columns[key])
    });

    const rows = [];
    const paged = txnSearch.runPaged({ pageSize: 1000 });

    for (let i = 0; i < paged.pageRanges.length && rows.length < CONFIG.maxRows; i++) {
      const page = paged.fetch({ index: paged.pageRanges[i].index });

      for (let j = 0; j < page.data.length && rows.length < CONFIG.maxRows; j++) {
        const result = page.data[j];
        const row = normalizeTransactionResult(result, columns);

        if (!filters.searchText || buildRowSearchText(row).indexOf(filters.searchText.toLowerCase()) >= 0) {
          rows.push(row);
        }
      }
    }

    return rows;
  }

  function normalizeTransactionResult(result, columns) {
    const type = String(result.getValue(columns.type) || '');
    const amount = coerceNumber(result.getValue(columns.amount));
    const fxAmount = coerceNumber(result.getValue(columns.fxAmount));

    return {
      id: String(result.getValue(columns.internalId) || ''),
      type,
      typeLabel: getTypeLabel(type),
      typeShortLabel: getTypeShortLabel(type),
      tranId: String(result.getValue(columns.tranId) || result.getValue(columns.transactionNumber) || ''),
      transactionNumber: String(result.getValue(columns.transactionNumber) || ''),
      tranDate: String(result.getValue(columns.tranDate) || ''),
      status: String(result.getText(columns.status) || result.getValue(columns.status) || ''),
      statusCode: String(result.getValue(columns.status) || ''),
      amount,
      fxAmount,
      displayAmount: fxAmount || amount,
      currency: String(result.getText(columns.currency) || result.getValue(columns.currency) || ''),
      createdFrom: String(result.getValue(columns.createdFrom) || ''),
      createdFromText: String(result.getText(columns.createdFrom) || ''),
      memo: String(result.getValue(columns.memo) || ''),
      recordUrl: buildTransactionUrl(type, result.getValue(columns.internalId))
    };
  }

  function buildRowSearchText(row) {
    return [
      row.id,
      row.typeLabel,
      row.tranId,
      row.transactionNumber,
      row.tranDate,
      row.status,
      row.displayAmount,
      row.currency,
      row.createdFromText,
      row.memo
    ].join(' ').toLowerCase();
  }

  function getVendorName(vendorId) {
    try {
      const lookup = search.lookupFields({
        type: search.Type.VENDOR,
        id: vendorId,
        columns: ['entityid', 'companyname', 'altname']
      });

      return String(lookup.companyname || lookup.altname || lookup.entityid || ('Vendor #' + vendorId));
    } catch (e) {
      log.error({
        title: 'Unable to look up vendor name ' + vendorId,
        details: e
      });
      return 'Vendor #' + vendorId;
    }
  }

  function buildTransactionUrl(type, id) {
    const config = CONFIG.transactionTypes[type];
    if (!config || !id) return '';

    try {
      return url.resolveRecord({
        recordType: config.recordType,
        recordId: id,
        isEditMode: false
      }) || '';
    } catch (e) {
      return '';
    }
  }

  function buildSummary(rows) {
    const summary = {
      total: rows.length,
      totalAmount: 0,
      purchaseOrders: 0,
      bills: 0,
      receipts: 0,
      payments: 0,
      credits: 0,
      latestDate: ''
    };

    rows.forEach(row => {
      summary.totalAmount += Number(row.displayAmount || 0);
      if (row.type === 'PurchOrd') summary.purchaseOrders += 1;
      if (row.type === 'VendBill') summary.bills += 1;
      if (row.type === 'ItemRcpt') summary.receipts += 1;
      if (row.type === 'VendPymt') summary.payments += 1;
      if (row.type === 'VendCred') summary.credits += 1;
    });

    const latest = rows.slice().sort(compareNewestFirst)[0];
    summary.latestDate = latest ? latest.tranDate : '';

    return summary;
  }

  function buildDashboardMetrics(rows) {
    const summary = {
      total: rows.length,
      totalAmount: 0,
      purchaseOrders: 0,
      bills: 0,
      receipts: 0,
      payments: 0,
      credits: 0,
      latestDate: ''
    };
    const typeMap = {};
    const monthlyMap = {};
    const poMonthlyMap = {};
    const poStatusMap = {};
    const billMonthlyMap = {};
    const receiptDateMap = {};
    const latestCandidates = [];
    let latestRow = null;
    let latestSortValue = -1;

    Object.keys(CONFIG.transactionTypes).forEach(type => {
      typeMap[type] = {
        type,
        label: CONFIG.transactionTypes[type].label,
        shortLabel: CONFIG.transactionTypes[type].shortLabel,
        count: 0,
        amount: 0
      };
    });

    rows.forEach(row => {
      const amount = Number(row.displayAmount || 0);
      const type = row.type;
      const dateObj = parseNsDate(row.tranDate);
      const month = getMonthKeyFromDate(dateObj);
      const monthLabel = getMonthLabelFromDate(dateObj);
      const sortValue = dateObj ? dateObj.getTime() : 0;
      const status = row.status || 'No Status';
      const numericId = Number(row.id || 0);

      summary.totalAmount += amount;
      if (type === 'PurchOrd') summary.purchaseOrders += 1;
      if (type === 'VendBill') summary.bills += 1;
      if (type === 'ItemRcpt') summary.receipts += 1;
      if (type === 'VendPymt') summary.payments += 1;
      if (type === 'VendCred') summary.credits += 1;

      latestCandidates.push({
        row,
        sortValue,
        id: numericId
      });

      if (sortValue > latestSortValue || (sortValue === latestSortValue && numericId > Number(latestRow && latestRow.id || 0))) {
        latestRow = row;
        latestSortValue = sortValue;
      }

      if (typeMap[type]) {
        typeMap[type].count += 1;
        typeMap[type].amount += amount;
      }

      if (!monthlyMap[month]) {
        monthlyMap[month] = {
          month,
          label: monthLabel,
          count: 0,
          amount: 0
        };
      }
      monthlyMap[month].count += 1;
      monthlyMap[month].amount += amount;

      if (type === 'PurchOrd') {
        if (!poMonthlyMap[month]) {
          poMonthlyMap[month] = {
            month,
            label: monthLabel,
            count: 0
          };
        }
        poMonthlyMap[month].count += 1;

        if (!poStatusMap[status]) {
          poStatusMap[status] = {
            label: status,
            count: 0
          };
        }
        poStatusMap[status].count += 1;
      }

      if (type === 'VendBill') {
        if (!billMonthlyMap[month]) {
          billMonthlyMap[month] = {
            month,
            label: monthLabel,
            count: 0,
            statusCounts: {}
          };
        }
        billMonthlyMap[month].count += 1;
        billMonthlyMap[month].statusCounts[status] = (billMonthlyMap[month].statusCounts[status] || 0) + 1;
      }

      if (type === 'ItemRcpt') {
        const receiptDate = row.tranDate || 'No Date';
        if (!receiptDateMap[receiptDate]) {
          receiptDateMap[receiptDate] = {
            label: receiptDate,
            count: 0,
            sortValue
          };
        }
        receiptDateMap[receiptDate].count += 1;
      }
    });

    summary.latestDate = latestRow ? latestRow.tranDate : '';

    return {
      summary,
      typeBreakdown: Object.keys(typeMap)
        .map(type => typeMap[type])
        .filter(item => item.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      monthlyTrend: mapValues(monthlyMap)
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12),
      poMonthlyTrend: mapValues(poMonthlyMap)
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12),
      poStatusBreakdown: compactStatusBreakdown(poStatusMap),
      receiptDateBreakdown: compactReceiptDateBreakdown(receiptDateMap),
      billMonthlyTrend: mapValues(billMonthlyMap)
        .map(item => {
          item.statusSummary = buildStatusSummary(item.statusCounts);
          return item;
        })
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-12),
      latestTransactions: latestCandidates
        .sort((a, b) => b.sortValue - a.sortValue || b.id - a.id)
        .slice(0, 6)
        .map(item => item.row)
    };
  }

  function compactStatusBreakdown(statusMap) {
    const sorted = mapValues(statusMap)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const top = sorted.slice(0, 4);
    const otherCount = sorted.slice(4).reduce((sum, item) => sum + Number(item.count || 0), 0);

    if (otherCount) {
      top.push({
        label: 'Other',
        count: otherCount
      });
    }

    return top;
  }

  function compactReceiptDateBreakdown(receiptDateMap) {
    const sorted = mapValues(receiptDateMap)
      .sort((a, b) => b.count - a.count || b.sortValue - a.sortValue || a.label.localeCompare(b.label));
    const top = sorted.slice(0, 3);
    const otherCount = sorted.slice(3).reduce((sum, item) => sum + Number(item.count || 0), 0);

    if (otherCount) {
      top.push({
        label: 'All Other',
        count: otherCount,
        sortValue: 0
      });
    }

    return top;
  }

  function mapValues(map) {
    return Object.keys(map || {}).map(key => map[key]);
  }

  function buildTypeBreakdown(rows) {
    const map = {};

    Object.keys(CONFIG.transactionTypes).forEach(type => {
      map[type] = {
        type,
        label: CONFIG.transactionTypes[type].label,
        shortLabel: CONFIG.transactionTypes[type].shortLabel,
        count: 0,
        amount: 0
      };
    });

    rows.forEach(row => {
      if (!map[row.type]) return;
      map[row.type].count += 1;
      map[row.type].amount += Number(row.displayAmount || 0);
    });

    return Object.keys(map)
      .map(type => map[type])
      .filter(item => item.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  function buildMonthlyTrend(rows) {
    const map = {};

    rows.forEach(row => {
      const dateObj = parseNsDate(row.tranDate);
      const key = dateObj ? dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) : 'Unknown';

      if (!map[key]) {
        map[key] = {
          month: key,
          label: key === 'Unknown' ? 'Unknown' : pad2(dateObj.getMonth() + 1) + '/' + dateObj.getFullYear(),
          count: 0,
          amount: 0
        };
      }

      map[key].count += 1;
      map[key].amount += Number(row.displayAmount || 0);
    });

    return Object.keys(map)
      .map(key => map[key])
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);
  }

  function buildTypeMonthlyTrend(rows, transactionType) {
    const map = {};

    rows.filter(row => row.type === transactionType).forEach(row => {
      const dateObj = parseNsDate(row.tranDate);
      const key = dateObj ? dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) : 'Unknown';

      if (!map[key]) {
        map[key] = {
          month: key,
          label: key === 'Unknown' ? 'Unknown' : pad2(dateObj.getMonth() + 1) + '/' + dateObj.getFullYear(),
          count: 0
        };
      }

      map[key].count += 1;
    });

    return Object.keys(map)
      .map(key => map[key])
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);
  }

  function buildTransactionStatusBreakdown(rows, transactionType) {
    const map = {};

    rows.filter(row => row.type === transactionType).forEach(row => {
      const status = row.status || 'No Status';

      if (!map[status]) {
        map[status] = {
          label: status,
          count: 0
        };
      }

      map[status].count += 1;
    });

    const sorted = Object.keys(map)
      .map(key => map[key])
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const top = sorted.slice(0, 4);
    const otherCount = sorted.slice(4).reduce((sum, item) => sum + Number(item.count || 0), 0);

    if (otherCount) {
      top.push({
        label: 'Other',
        count: otherCount
      });
    }

    return top;
  }

  function buildBillMonthlyTrend(rows) {
    const map = {};

    rows.filter(row => row.type === 'VendBill').forEach(row => {
      const dateObj = parseNsDate(row.tranDate);
      const key = dateObj ? dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) : 'Unknown';
      const status = row.status || 'No Status';

      if (!map[key]) {
        map[key] = {
          month: key,
          label: key === 'Unknown' ? 'Unknown' : pad2(dateObj.getMonth() + 1) + '/' + dateObj.getFullYear(),
          count: 0,
          statusCounts: {}
        };
      }

      map[key].count += 1;
      map[key].statusCounts[status] = (map[key].statusCounts[status] || 0) + 1;
    });

    return Object.keys(map)
      .map(key => {
        const item = map[key];
        item.statusSummary = buildStatusSummary(item.statusCounts);
        return item;
      })
      .sort((a, b) => a.month.localeCompare(b.month))
      .slice(-12);
  }

  function buildStatusSummary(statusCounts) {
    const statuses = Object.keys(statusCounts || {})
      .map(status => ({
        status,
        count: Number(statusCounts[status] || 0)
      }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));

    if (!statuses.length) return 'Status: No Status';

    const visible = statuses.slice(0, 2).map(item => item.status + ': ' + item.count);
    const otherCount = statuses.slice(2).reduce((sum, item) => sum + item.count, 0);
    if (otherCount) visible.push('Other: ' + otherCount);

    return 'Status: ' + visible.join(', ');
  }

  function buildReceiptDateBreakdown(rows) {
    const map = {};

    rows.filter(row => row.type === 'ItemRcpt').forEach(row => {
      const key = row.tranDate || 'No Date';

      if (!map[key]) {
        map[key] = {
          label: key,
          count: 0,
          sortValue: getDateSortValue(row.tranDate)
        };
      }

      map[key].count += 1;
    });

    const sorted = Object.keys(map)
      .map(key => map[key])
      .sort((a, b) => b.count - a.count || b.sortValue - a.sortValue || a.label.localeCompare(b.label));
    const top = sorted.slice(0, 3);
    const otherCount = sorted.slice(3).reduce((sum, item) => sum + Number(item.count || 0), 0);

    if (otherCount) {
      top.push({
        label: 'All Other',
        count: otherCount,
        sortValue: 0
      });
    }

    return top;
  }

  function buildHtml(data, filters) {
    if (!filters.vendorId) {
      return buildCss() + buildScript() + `
<div class="v360">
  <section class="empty-state">
    <h2>Select a vendor to view transactions</h2>
    <p>Choose a vendor from the dropdown above. The page defaults to all transaction types from the last 3 years.</p>
  </section>
</div>`;
    }

    return `
${buildCss()}
<div class="v360">
  <div class="topbar">
    <div>
      <h1>${esc(data.vendorName)}</h1>
      <div class="subline">${esc(buildFilterSubtitle(filters))}</div>
    </div>
    <div class="refresh">
      ${esc(formatLastRefreshed(data.generatedAt))}
    </div>
  </div>

  ${data.hitLimit ? `<div class="warning">Showing the first ${esc(formatWholeNumber(CONFIG.maxRows))} matching transactions. Add a date range or search text for a narrower result.</div>` : ''}

  ${buildKpis(data.summary)}

  <div class="dashboard-grid">
    <section class="panel transaction-mix-panel">
      <div class="panel-head">
        <div>
          <h2>Transaction Categories</h2>
          <span>All selected vendor transactions grouped by transaction type</span>
        </div>
      </div>
      ${buildTransactionCircle(data.typeBreakdown, data.summary.total)}
    </section>

    <section class="panel latest-panel">
      <div class="panel-head">
        <div>
          <h2>Latest Activity</h2>
          <span>Newest vendor transactions in this result</span>
        </div>
      </div>
      ${buildLatestActivity(data.latestTransactions)}
    </section>
  </div>

  <div class="dashboard-grid lower">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>12 Month Volume</h2>
          <span>Transaction count by month</span>
        </div>
      </div>
      ${buildMonthlyTrendChart(data.monthlyTrend)}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Amount by Type</h2>
          <span>Net amount for each transaction group</span>
        </div>
      </div>
      ${buildAmountBars(data.typeBreakdown)}
    </section>
  </div>

  <div class="dashboard-grid receipt-analysis">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>No. of POs by Month</h2>
          <span>Purchase order count grouped by transaction month</span>
        </div>
      </div>
      ${buildPoMonthlyBars(data.poMonthlyTrend)}
    </section>
  </div>

  <div class="dashboard-grid po-receipt-analysis">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>No. of POs by Status</h2>
          <span>Purchase order count grouped by transaction status</span>
        </div>
      </div>
      ${buildPoStatusDonut(data.poStatusBreakdown)}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>No. of Receipts by Date</h2>
          <span>Top receipt dates by item receipt count</span>
        </div>
      </div>
      ${buildReceiptDateDonut(data.receiptDateBreakdown)}
    </section>
  </div>

  <div class="dashboard-grid bill-analysis">
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>No. of Bills by Month</h2>
          <span>Vendor bill count grouped by transaction month</span>
        </div>
      </div>
      ${buildBillMonthlyFunnel(data.billMonthlyTrend)}
    </section>
  </div>

  <section class="panel table-panel">
    <div class="panel-head">
      <div>
        <h2>Transaction Drilldown</h2>
        <span id="rowCount">${esc(buildRowCountText(data.rows.length))}</span>
      </div>
      <div class="table-actions">
        <button type="button" class="btn" onclick="clearClientFilter()">Show All</button>
      </div>
    </div>
    ${buildTransactionTable(data.rows)}
  </section>
</div>
${buildScript()}
`;
  }

  function buildFilterSubtitle(filters) {
    const parts = [];
    parts.push(filters.transactionType === 'ALL' ? 'All transaction types' : getTypeLabel(filters.transactionType));
    if (filters.dateFrom || filters.dateTo) {
      parts.push((filters.dateFrom || 'Beginning') + ' to ' + (filters.dateTo || 'Today'));
    } else {
      parts.push('All dates');
    }
    if (filters.searchText) parts.push('Search: ' + filters.searchText);
    return parts.join(' | ');
  }

  function buildKpis(summary) {
    const cards = [
      { label: 'Total Transactions', value: summary.total, tone: 'blue', type: 'ALL' },
      { label: 'Purchase Orders', value: summary.purchaseOrders, tone: 'po', type: 'PurchOrd' },
      { label: 'Bills', value: summary.bills, tone: 'bill', type: 'VendBill' },
      { label: 'Receipts', value: summary.receipts, tone: 'receipt', type: 'ItemRcpt' },
      { label: 'Payments', value: summary.payments, tone: 'payment', type: 'VendPymt' },
      { label: 'Credits', value: summary.credits, tone: 'credit', type: 'VendCred' },
      { label: 'Latest Activity', value: summary.latestDate || 'None', tone: 'neutral', type: 'ALL' }
    ];

    return `<div class="kpi-grid">${cards.map(card => `
      <button type="button" class="kpi-card ${escAttr(card.tone)}" onclick="setTypeFilter(${jsString(card.type)})">
        <span>${esc(card.label)}</span>
        <b>${esc(card.value)}</b>
      </button>`).join('')}</div>`;
  }

  function buildTransactionCircle(items, total) {
    if (!items.length) return '<div class="empty-chart">No transactions found for this vendor and filter.</div>';

    const width = 760;
    const height = 520;
    const cx = 380;
    const cy = 250;
    const outerRadius = 162;
    const innerRadius = 88;
    const labelRadius = 224;
    let angle = 0;

    const gradients = items.map((item, index) => {
      const color = getTypeColor(item.type);
      const colorEnd = getTypeColorEnd(item.type);
      return `
        <linearGradient id="txnGradient${index}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(color)}"></stop>
          <stop offset="100%" stop-color="${escAttr(colorEnd)}"></stop>
        </linearGradient>`;
    }).join('');

    const slices = items.map((item, index) => {
      const value = Number(item.count || 0);
      const startAngle = angle;
      const endAngle = angle + ((value / Math.max(1, total)) * 360);
      const midAngle = startAngle + ((endAngle - startAngle) / 2);
      const labelPoint = polarToCartesian(cx, cy, labelRadius, midAngle);
      const connectorStart = polarToCartesian(cx, cy, outerRadius + 12, midAngle);
      const connectorEnd = polarToCartesian(cx, cy, labelRadius - 18, midAngle);
      const textAnchor = labelPoint.x < cx - 12 ? 'end' : labelPoint.x > cx + 12 ? 'start' : 'middle';
      const path = describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle);

      angle = endAngle;

      return `
        <path class="txn-slice" d="${path}" fill="url(#txnGradient${index})" onclick="applyClientFilter(${jsString(item.type)}, '', '', '')">
          <title>${esc(item.label)}: ${value}</title>
        </path>
        <line x1="${connectorStart.x}" y1="${connectorStart.y}" x2="${connectorEnd.x}" y2="${connectorEnd.y}" class="slice-connector"></line>
        <text x="${labelPoint.x}" y="${labelPoint.y - 5}" text-anchor="${textAnchor}" class="circle-label">${esc(item.shortLabel)}</text>
        <text x="${labelPoint.x}" y="${labelPoint.y + 18}" text-anchor="${textAnchor}" class="circle-count">${esc(value)}</text>`;
    }).join('');

    return `
<div class="circle-wrap">
  <svg class="txn-circle" viewBox="0 0 ${width} ${height}" role="img" aria-label="Vendor transaction categories">
    <defs>${gradients}</defs>
    <circle cx="${cx}" cy="${cy}" r="${outerRadius + 24}" class="outer-ring"></circle>
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 10}" class="center-disc"></circle>
    <text x="${cx}" y="${cy - 9}" text-anchor="middle" class="center-total">${esc(total)}</text>
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" class="center-label">TRANSACTIONS</text>
  </svg>
  <div class="legend-grid">
    ${items.map(item => `
      <button type="button" class="legend-chip" onclick="applyClientFilter(${jsString(item.type)}, '', '', '')">
        <span style="background:linear-gradient(135deg,${escAttr(getTypeColor(item.type))},${escAttr(getTypeColorEnd(item.type))})"></span>
        <b>${esc(item.label)}</b>
        <small>${esc(item.count)}</small>
      </button>`).join('')}
  </div>
</div>`;
  }

  function buildLatestActivity(rows) {
    if (!rows.length) return '<div class="empty-list">No recent transactions found.</div>';

    return `<div class="activity-list">${rows.map(row => `
      <a class="activity-row" href="${escAttr(row.recordUrl || '#')}" target="_blank" rel="noopener">
        <span class="type-dot" style="background:${escAttr(getTypeColor(row.type))}"></span>
        <div>
          <b>${esc(row.tranId || ('Internal ID ' + row.id))}</b>
          <small>${esc(row.typeLabel)} | ${esc(row.tranDate || 'No date')} | ${esc(row.status || 'No status')}</small>
        </div>
        <strong>${esc(formatAmount(row.displayAmount))}</strong>
      </a>`).join('')}</div>`;
  }

  function buildMonthlyTrendChart(trend) {
    if (!trend.length) return '<div class="empty-chart short">No month activity found.</div>';

    const width = 760;
    const height = 285;
    const left = 58;
    const right = 34;
    const top = 52;
    const bottom = 64;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const max = Math.max(1, Math.max.apply(null, trend.map(item => Number(item.count || 0))));
    const points = trend.map((item, index) => {
      const count = Number(item.count || 0);
      const x = trend.length === 1 ? left + (plotWidth / 2) : left + ((plotWidth / Math.max(1, trend.length - 1)) * index);
      const y = top + plotHeight - ((count / max) * plotHeight);

      return {
        item,
        count,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100
      };
    });
    const baselineY = top + plotHeight;
    const linePath = buildSmoothTrendPath(points, false);
    const areaPath = points.length ?
      'M ' + points[0].x + ' ' + baselineY +
      ' L ' + points[0].x + ' ' + points[0].y +
      ' ' + buildSmoothTrendPath(points, true) +
      ' L ' + points[points.length - 1].x + ' ' + baselineY +
      ' Z' :
      '';
    const pointMarkup = points.map(point => `
        <circle cx="${point.x}" cy="${point.y}" r="13" class="trend-hit" onclick="applyClientFilter('', '', ${jsString(point.item.month)}, '')">
          <title>${esc(point.item.label)}: ${esc(point.count)} transaction(s)</title>
        </circle>
        <circle cx="${point.x}" cy="${point.y}" r="14" class="trend-point-glow trend-point-glow-wide"></circle>
        <circle cx="${point.x}" cy="${point.y}" r="8" class="trend-point-glow trend-point-glow-tight"></circle>
        <circle cx="${point.x}" cy="${point.y}" r="4.5" class="trend-point" onclick="applyClientFilter('', '', ${jsString(point.item.month)}, '')"></circle>
        <text x="${point.x}" y="${Math.max(top - 10, point.y - 12)}" text-anchor="middle" class="trend-value">${esc(point.count)}</text>
        <text x="${point.x}" y="${height - 24}" text-anchor="end" transform="rotate(-38 ${point.x} ${height - 24})" class="axis-label">${esc(point.item.label)}</text>`).join('');

    const grid = [0, 0.5, 1].map(percent => {
      const y = top + plotHeight - (plotHeight * percent);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid-line"></line><text x="8" y="${y + 4}" class="axis-label">${Math.round(max * percent)}</text>`;
    }).join('');

    return `
<div class="trend-wrap">
  <div class="trend-legend"><span></span><b>Transaction Count</b></div>
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly transaction volume">
    <defs>
      <linearGradient id="monthlyAreaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#8b5cf6" stop-opacity=".34"></stop>
        <stop offset="45%" stop-color="#38bdf8" stop-opacity=".22"></stop>
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0"></stop>
      </linearGradient>
      <linearGradient id="monthlyLineGradient" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#fb7185"></stop>
        <stop offset="35%" stop-color="#facc15"></stop>
        <stop offset="68%" stop-color="#60a5fa"></stop>
        <stop offset="100%" stop-color="#fb923c"></stop>
      </linearGradient>
    </defs>
    <path d="${areaPath}" class="trend-area"></path>
    ${grid}
    <path d="${linePath}" class="trend-line-glow"></path>
    <path d="${linePath}" class="trend-line"></path>
    ${pointMarkup}
    <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" class="axis-line"></line>
  </svg>
</div>`;
  }

  function buildSmoothTrendPath(points, skipMove) {
    if (!points.length) return '';
    let path = skipMove ? '' : 'M ' + points[0].x + ' ' + points[0].y;

    for (let index = 0; index < points.length - 1; index++) {
      const previous = points[index - 1] || points[index];
      const current = points[index];
      const next = points[index + 1];
      const following = points[index + 2] || next;
      const control1X = Math.round((current.x + ((next.x - previous.x) / 6)) * 100) / 100;
      const control1Y = Math.round((current.y + ((next.y - previous.y) / 6)) * 100) / 100;
      const control2X = Math.round((next.x - ((following.x - current.x) / 6)) * 100) / 100;
      const control2Y = Math.round((next.y - ((following.y - current.y) / 6)) * 100) / 100;
      path += ' C ' + control1X + ' ' + control1Y + ' ' + control2X + ' ' + control2Y + ' ' + next.x + ' ' + next.y;
    }

    return path;
  }

  function buildPoMonthlyBars(trend) {
    if (!trend.length) return '<div class="empty-chart short">No purchase orders found for this date range.</div>';

    const width = 760;
    const height = 270;
    const left = 52;
    const right = 22;
    const top = 30;
    const bottom = 66;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const max = Math.max(1, Math.max.apply(null, trend.map(item => Number(item.count || 0))));
    const slot = plotWidth / Math.max(1, trend.length);
    const barWidth = Math.max(18, Math.min(48, slot * 0.54));
    const baselineY = top + plotHeight;
    const gradients = trend.map((item, index) => {
      const count = Number(item.count || 0);
      const color = getPoMonthlyBarGradient(count, max, index);

      return `
        <linearGradient id="poMonthGradient${index}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(color.top)}"></stop>
          <stop offset="48%" stop-color="${escAttr(color.mid)}"></stop>
          <stop offset="100%" stop-color="${escAttr(color.bottom)}"></stop>
        </linearGradient>
        <linearGradient id="poMonthShadowGradient${index}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${escAttr(color.top)}" stop-opacity=".24"></stop>
          <stop offset="58%" stop-color="${escAttr(color.mid)}" stop-opacity=".18"></stop>
          <stop offset="100%" stop-color="${escAttr(color.bottom)}" stop-opacity=".08"></stop>
        </linearGradient>
        <radialGradient id="poMonthBaseShadowGradient${index}" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${escAttr(color.mid)}" stop-opacity=".28"></stop>
          <stop offset="72%" stop-color="${escAttr(color.bottom)}" stop-opacity=".12"></stop>
          <stop offset="100%" stop-color="${escAttr(color.bottom)}" stop-opacity="0"></stop>
        </radialGradient>`;
    }).join('');

    const bars = trend.map((item, index) => {
      const count = Number(item.count || 0);
      const barHeight = Math.round((count / max) * plotHeight);
      const x = left + (slot * index) + ((slot - barWidth) / 2);
      const y = top + plotHeight - barHeight;
      const labelX = x + (barWidth / 2);
      const glowInset = Math.max(12, Math.round(barWidth * 0.48));
      const glowX = x - glowInset;
      const glowY = Math.max(top, y - 4);
      const glowWidth = barWidth + (glowInset * 2);
      const glowHeight = Math.max(10, baselineY - glowY + 12);
      const shadowInset = Math.max(4, Math.round(barWidth * 0.12));
      const shadowX = x - shadowInset;
      const shadowY = Math.min(baselineY - 6, y + 5);
      const shadowWidth = barWidth + (shadowInset * 2);
      const shadowHeight = Math.max(8, baselineY - shadowY);

      return `
        <rect x="${glowX}" y="${glowY}" width="${glowWidth}" height="${glowHeight}" rx="12" fill="url(#poMonthShadowGradient${index})" class="po-bar-glow-wide"></rect>
        <rect x="${shadowX}" y="${shadowY}" width="${shadowWidth}" height="${shadowHeight}" rx="7" fill="url(#poMonthShadowGradient${index})" class="po-bar-bg-shadow"></rect>
        <ellipse cx="${labelX}" cy="${baselineY + 6}" rx="${Math.round(barWidth * 0.92)}" ry="7" fill="url(#poMonthBaseShadowGradient${index})" class="po-bar-base-shadow"></ellipse>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="5" fill="url(#poMonthGradient${index})" class="trend-bar po-month-bar" onclick="applyClientFilter('PurchOrd', '', ${jsString(item.month)}, '')">
          <title>${esc(item.label)}: ${esc(count)} purchase order(s)</title>
        </rect>
        <rect x="${x + 5}" y="${y + 6}" width="${Math.max(4, Math.round(barWidth * 0.22))}" height="${Math.max(0, barHeight - 12)}" rx="4" class="po-bar-highlight"></rect>
        <text x="${labelX}" y="${Math.max(top + 13, y - 8)}" text-anchor="middle" class="bar-value">${esc(count)}</text>
        <text x="${labelX}" y="${height - 26}" text-anchor="end" transform="rotate(-34 ${labelX} ${height - 26})" class="axis-label">${esc(item.label)}</text>`;
    }).join('');

    const grid = [0, 0.5, 1].map(percent => {
      const y = top + plotHeight - (plotHeight * percent);
      return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}" class="grid-line"></line><text x="10" y="${y + 4}" class="axis-label">${Math.round(max * percent)}</text>`;
    }).join('');

    return `
<div class="trend-wrap po-month-wrap">
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Purchase orders by month">
    <defs>${gradients}</defs>
    ${grid}
    ${bars}
    <line x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}" class="axis-line"></line>
  </svg>
</div>`;
  }

  function getPoMonthlyBarGradient(count, max, index) {
    if (Number(max || 0) > 1 && Number(count || 0) === Number(max || 0)) {
      return {
        top: '#fb7185',
        mid: '#ef4444',
        bottom: '#b91c1c'
      };
    }

    const colors = [
      { top: '#93c5fd', mid: '#60a5fa', bottom: '#2563eb' },
      { top: '#5eead4', mid: '#14b8a6', bottom: '#0f766e' },
      { top: '#fdba74', mid: '#f97316', bottom: '#c2410c' },
      { top: '#c4b5fd', mid: '#8b5cf6', bottom: '#6d28d9' },
      { top: '#f9a8d4', mid: '#db2777', bottom: '#9d174d' },
      { top: '#86efac', mid: '#22c55e', bottom: '#15803d' },
      { top: '#fde68a', mid: '#facc15', bottom: '#ca8a04' },
      { top: '#67e8f9', mid: '#06b6d4', bottom: '#0e7490' },
      { top: '#fed7aa', mid: '#fb923c', bottom: '#ea580c' },
      { top: '#cbd5e1', mid: '#64748b', bottom: '#334155' },
      { top: '#bef264', mid: '#84cc16', bottom: '#4d7c0f' },
      { top: '#d8b4fe', mid: '#a855f7', bottom: '#7e22ce' }
    ];

    return colors[index % colors.length];
  }

  function buildPoStatusDonut(items) {
    if (!items.length) return '<div class="empty-chart short">No purchase orders found for this date range.</div>';

    const width = 360;
    const height = 250;
    const cx = 180;
    const cy = 124;
    const outerRadius = 88;
    const innerRadius = 52;
    const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const gradients = items.map((item, index) => {
      const color = getPoStatusColor(item.label, index);

      return `
        <linearGradient id="poStatusGradient${index}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${escAttr(color.top)}"></stop>
          <stop offset="58%" stop-color="${escAttr(color.mid)}"></stop>
          <stop offset="100%" stop-color="${escAttr(color.bottom)}"></stop>
        </linearGradient>`;
    }).join('');
    let angle = 0;

    const segments = items.map((item, index) => {
      const count = Number(item.count || 0);
      const startAngle = angle;
      const endAngle = angle + ((count / Math.max(1, total)) * 360);
      const percent = Math.round((count / Math.max(1, total)) * 1000) / 10;
      const color = getPoStatusColor(item.label, index);
      const path = describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle);

      angle = endAngle;

      return {
        item,
        count,
        percent,
        color,
        path,
        index
      };
    });
    const glows = segments.map(segment => `
        <path class="po-status-glow" d="${segment.path}" fill="${escAttr(segment.color.shadow)}"></path>`).join('');
    const slices = segments.map(segment => `
        <path class="po-status-slice" d="${segment.path}" fill="url(#poStatusGradient${segment.index})" onclick="applyClientFilter('PurchOrd', ${jsString(segment.item.label)}, '', '')">
          <title>${esc(segment.item.label)}: ${esc(segment.count)} purchase order(s), ${esc(segment.percent)}%</title>
        </path>`).join('');
    const legend = segments.map(segment => `
    <button type="button" class="po-status-legend-row" onclick="applyClientFilter('PurchOrd', ${jsString(segment.item.label)}, '', '')">
      <span style="background:linear-gradient(135deg,${escAttr(segment.color.top)},${escAttr(segment.color.bottom)})"></span>
      <b>${esc(segment.item.label)}</b>
      <small>${esc(segment.count)} | ${esc(segment.percent)}%</small>
    </button>`).join('');

    return `
<div class="po-status-wrap">
  <svg class="po-status-donut" viewBox="0 0 ${width} ${height}" role="img" aria-label="Purchase orders by status">
    <defs>${gradients}</defs>
    ${glows}
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 4}" class="po-status-hole"></circle>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" class="po-status-center-label">PO Status</text>
    <text x="${cx}" y="${cy + 29}" text-anchor="middle" class="po-status-center-total">${esc(total)}</text>
  </svg>
  <div class="po-status-legend">${legend}</div>
</div>`;
  }

  function getPoStatusColor(label, index) {
    const normalized = String(label || '').toLowerCase();
    const semanticColors = [
      { key: 'closed', top: '#ffb454', mid: '#ff8a12', bottom: '#fb6f10', shadow: '#ff9d2e' },
      { key: 'pending', top: '#59f0d2', mid: '#2ddfbd', bottom: '#18bfa4', shadow: '#36e7c8' },
      { key: 'fully', top: '#49d7e4', mid: '#28c7d8', bottom: '#18a8c4', shadow: '#27c9dc' },
      { key: 'other', top: '#b7c1ff', mid: '#9ba9ff', bottom: '#7d8ff0', shadow: '#9caaff' }
    ];
    const semantic = semanticColors.find(color => normalized.indexOf(color.key) >= 0);
    const fallback = [
      { top: '#59f0d2', mid: '#2ddfbd', bottom: '#18bfa4', shadow: '#36e7c8' },
      { top: '#ffb454', mid: '#ff8a12', bottom: '#fb6f10', shadow: '#ff9d2e' },
      { top: '#b7c1ff', mid: '#9ba9ff', bottom: '#7d8ff0', shadow: '#9caaff' },
      { top: '#49d7e4', mid: '#28c7d8', bottom: '#18a8c4', shadow: '#27c9dc' },
      { top: '#f9a8d4', mid: '#ec4899', bottom: '#be185d', shadow: '#ec4899' }
    ];

    return semantic || fallback[index % fallback.length];
  }

  function buildBillMonthlyFunnel(trend) {
    if (!trend.length) return '<div class="empty-chart short">No vendor bills found for this date range.</div>';

    const items = trend.slice()
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.month).localeCompare(String(b.month)));
    const width = 760;
    const top = 18;
    const segmentHeight = 42;
    const gap = 4;
    const bottom = 30;
    const height = top + bottom + (items.length * segmentHeight) + ((items.length - 1) * gap);
    const cx = width / 2;
    const maxWidth = 430;
    const minWidth = 180;

    const segments = items.map((item, index) => {
      const count = Number(item.count || 0);
      const y = top + (index * (segmentHeight + gap));
      const topWidth = getFunnelWidth(index, items.length, maxWidth, minWidth);
      const bottomWidth = getFunnelWidth(index + 1, items.length, maxWidth, minWidth);
      const fill = getBillFunnelColor(index, items.length);
      const points = [
        (cx - (topWidth / 2)) + ',' + y,
        (cx + (topWidth / 2)) + ',' + y,
        (cx + (bottomWidth / 2)) + ',' + (y + segmentHeight),
        (cx - (bottomWidth / 2)) + ',' + (y + segmentHeight)
      ].join(' ');
      const shadowPoints = [
        (cx - (topWidth / 2) + 10) + ',' + (y + 10),
        (cx + (topWidth / 2) + 10) + ',' + (y + 10),
        (cx + (bottomWidth / 2) + 10) + ',' + (y + segmentHeight + 10),
        (cx - (bottomWidth / 2) + 10) + ',' + (y + segmentHeight + 10)
      ].join(' ');

      return `
        <polygon points="${shadowPoints}" class="bill-funnel-shadow" fill="${escAttr(fill)}"></polygon>
        <polygon points="${points}" class="bill-funnel-segment" fill="${escAttr(fill)}" onclick="applyClientFilter('VendBill', '', ${jsString(item.month)}, '')">
          <title>${esc(item.label)}: ${esc(count)} vendor bill(s) | ${esc(item.statusSummary || 'Status: No Status')}</title>
        </polygon>
        <text x="${cx}" y="${y + 18}" text-anchor="middle" class="bill-funnel-label">${esc(item.label)}: ${esc(count)}</text>
        <text x="${cx}" y="${y + 33}" text-anchor="middle" class="bill-funnel-status">${esc(item.statusSummary || 'Status: No Status')}</text>`;
    }).join('');

    return `
<div class="bill-funnel-wrap">
  <svg class="bill-funnel" viewBox="0 0 ${width} ${height}" role="img" aria-label="Vendor bills by month">
    ${segments}
  </svg>
</div>`;
  }

  function getFunnelWidth(index, total, maxWidth, minWidth) {
    if (total <= 1) return index === 0 ? maxWidth : Math.round(maxWidth * 0.74);
    const boundedIndex = Math.min(index, total);
    const percent = boundedIndex / total;
    return Math.round(maxWidth - ((maxWidth - minWidth) * percent));
  }

  function getBillFunnelColor(index, total) {
    if (total <= 3) return ['#8bd34a', '#facc15', '#ef4444'][index] || '#ef4444';
    const colors = ['#8bd34a', '#a7dc4f', '#facc15', '#fb923c', '#f97316', '#ef4444'];
    const colorIndex = Math.min(colors.length - 1, Math.round((index / Math.max(1, total - 1)) * (colors.length - 1)));
    return colors[colorIndex];
  }

  function buildReceiptDateDonut(items) {
    if (!items.length) return '<div class="empty-chart short">No item receipts found for this date range.</div>';

    const width = 560;
    const height = 320;
    const cx = 280;
    const cy = 152;
    const outerRadius = 88;
    const innerRadius = 48;
    const total = items.reduce((sum, item) => sum + Number(item.count || 0), 0);
    let angle = 0;

    const segments = items.map((item, index) => {
      const count = Number(item.count || 0);
      const dateFilter = item.label === 'All Other' ? '' : item.label;
      const startAngle = angle;
      const endAngle = angle + ((count / Math.max(1, total)) * 360);
      const percent = Math.round((count / Math.max(1, total)) * 1000) / 10;
      const color = getReceiptDateColor(index);
      const path = describeDonutSegment(cx, cy, outerRadius, innerRadius, startAngle, endAngle);

      angle = endAngle;

      return { item, count, dateFilter, percent, color, path };
    });
    const slices = segments.map(segment => `
        <path class="receipt-date-slice" d="${segment.path}" fill="${escAttr(segment.color)}" onclick="applyClientFilter('ItemRcpt', '', '', ${jsString(segment.dateFilter)})">
          <title>${esc(segment.item.label)}: ${esc(segment.count)} receipt(s), ${esc(segment.percent)}%</title>
        </path>`).join('');
    const legend = segments.map(segment => `
    <button type="button" class="receipt-date-legend-row" onclick="applyClientFilter('ItemRcpt', '', '', ${jsString(segment.dateFilter)})">
      <span style="background:${escAttr(segment.color)}"></span>
      <b>${esc(segment.item.label)}</b>
      <small>${esc(segment.count)} | ${esc(segment.percent)}%</small>
    </button>`).join('');

    return `
<div class="receipt-date-wrap">
  <svg class="receipt-date-donut" viewBox="0 0 ${width} ${height}" role="img" aria-label="Item receipts by date">
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${innerRadius - 8}" class="center-disc"></circle>
    <text x="${cx}" y="${cy - 7}" text-anchor="middle" class="receipt-center-total">${esc(total)}</text>
    <text x="${cx}" y="${cy + 18}" text-anchor="middle" class="receipt-center-label">RECEIPTS</text>
  </svg>
  <div class="receipt-date-legend">${legend}</div>
</div>`;
  }

  function getReceiptDateColor(index) {
    const colors = ['#22c55e', '#facc15', '#22d3ee', '#fb923c'];
    return colors[index % colors.length];
  }

  function buildAmountBars(items) {
    if (!items.length) return '<div class="empty-chart short">No amount data found.</div>';

    const max = Math.max.apply(null, items.map(item => Math.abs(Number(item.amount || 0))).concat([1]));

    return `<div class="amount-bars">${items.map(item => {
      const percent = Math.round((Math.abs(Number(item.amount || 0)) / max) * 1000) / 10;
      return `
        <button type="button" class="amount-row" onclick="applyClientFilter(${jsString(item.type)}, '', '', '')">
          <span class="amount-label">${esc(item.label)}</span>
          <span class="amount-track"><span style="width:${percent}%;background:linear-gradient(90deg,${escAttr(getTypeColor(item.type))},${escAttr(getTypeColorEnd(item.type))})"></span></span>
          <b>${esc(formatAmount(item.amount))}</b>
        </button>`;
    }).join('')}</div>`;
  }

  function buildTransactionTable(rows) {
    return `
<div class="table-scroll">
  <table id="transactionTable" class="txn-table">
    <thead>
      <tr>
        <th><button type="button" onclick="sortTable(0,'text')">Transaction</button></th>
        <th><button type="button" onclick="sortTable(1,'text')">Type</button></th>
        <th><button type="button" onclick="sortTable(2,'date')">Date</button></th>
        <th><button type="button" onclick="sortTable(3,'text')">Status</button></th>
        <th><button type="button" onclick="sortTable(4,'number')">Amount</button></th>
        <th>Created From</th>
        <th>Memo</th>
      </tr>
    </thead>
    <tbody>
      ${rows.length ? rows.map((row, index) => buildTransactionRow(row, index)).join('') : '<tr><td colspan="7" class="empty-row">No transactions found for the selected vendor and filters.</td></tr>'}
    </tbody>
  </table>
</div>
${buildPager(rows.length)}`;
  }

  function buildTransactionRow(row, index) {
    const hidden = index >= CONFIG.tablePageSize ? ' style="display:none"' : '';
    return `
<tr data-row-index="${index}" data-type="${escAttr(row.type)}" data-status="${escAttr(row.status || 'No Status')}" data-month="${escAttr(getMonthKey(row.tranDate))}" data-tran-date="${escAttr(row.tranDate || 'No Date')}" data-search="${escAttr(buildRowSearchText(row))}"${hidden}>
  <td data-sort-value="${escAttr(row.tranId || row.id)}">${buildTransactionLink(row)}</td>
  <td data-sort-value="${escAttr(row.typeLabel)}"><span class="type-pill" style="background:${escAttr(getTypeSoftColor(row.type))};color:${escAttr(getTypeColor(row.type))}">${esc(row.typeShortLabel)}</span></td>
  <td data-sort-value="${escAttr(getDateSortValue(row.tranDate))}">${esc(row.tranDate)}</td>
  <td data-sort-value="${escAttr(row.status)}">${esc(row.status)}</td>
  <td class="amount-cell" data-sort-value="${escAttr(row.displayAmount)}">${esc(formatAmount(row.displayAmount))}</td>
  <td>${esc(row.createdFromText)}</td>
  <td title="${escAttr(row.memo)}">${esc(truncateText(row.memo, 90))}</td>
</tr>`;
  }

  function buildTransactionLink(row) {
    const label = row.tranId || row.transactionNumber || ('Internal ID ' + row.id);
    if (!row.recordUrl) return esc(label);

    return `<a class="table-link" href="${escAttr(row.recordUrl)}" target="_blank" rel="noopener">${esc(label)}</a>`;
  }

  function buildPager(total) {
    if (total <= CONFIG.tablePageSize) return '';

    return `
<div class="pager">
  <span id="pagerText">${CONFIG.tablePageSize} of ${esc(total)} shown</span>
  <button type="button" class="btn" id="loadMoreBtn" onclick="loadMoreRows()">Load Next ${CONFIG.tablePageSize}</button>
</div>`;
  }

  function buildRowCountText(total) {
    if (!total) return '0 transactions shown';
    return Math.min(total, CONFIG.tablePageSize) + ' of ' + total + ' transactions shown';
  }

  function getTypeLabel(type) {
    return CONFIG.transactionTypes[type] ? CONFIG.transactionTypes[type].label : String(type || 'Other');
  }

  function getTypeShortLabel(type) {
    return CONFIG.transactionTypes[type] ? CONFIG.transactionTypes[type].shortLabel : String(type || 'Other');
  }

  function getTypeColor(type) {
    return CONFIG.transactionTypes[type] ? CONFIG.transactionTypes[type].color : '#64748b';
  }

  function getTypeColorEnd(type) {
    return CONFIG.transactionTypes[type] ? CONFIG.transactionTypes[type].colorEnd : '#94a3b8';
  }

  function getTypeSoftColor(type) {
    const colors = {
      PurchOrd: '#dbeafe',
      VendBill: '#ffedd5',
      ItemRcpt: '#ccfbf1',
      VendPymt: '#ede9fe',
      VendCred: '#fce7f3'
    };
    return colors[type] || '#e2e8f0';
  }

  function compareNewestFirst(a, b) {
    const aDate = getDateSortValue(a.tranDate);
    const bDate = getDateSortValue(b.tranDate);
    return bDate - aDate || Number(b.id || 0) - Number(a.id || 0);
  }

  function parseNsDate(value) {
    if (!value) return null;

    try {
      const parsed = format.parse({
        value: String(value),
        type: format.Type.DATE
      });

      if (parsed && !isNaN(parsed.getTime())) return parsed;
    } catch (e) {
      // Fall through to native parsing.
    }

    const nativeDate = new Date(value);
    return isNaN(nativeDate.getTime()) ? null : nativeDate;
  }

  function getDateSortValue(value) {
    const parsed = parseNsDate(value);
    return parsed ? parsed.getTime() : 0;
  }

  function getMonthKey(value) {
    return getMonthKeyFromDate(parseNsDate(value));
  }

  function getMonthKeyFromDate(dateObj) {
    return dateObj ? dateObj.getFullYear() + '-' + pad2(dateObj.getMonth() + 1) : 'Unknown';
  }

  function getMonthLabelFromDate(dateObj) {
    return dateObj ? pad2(dateObj.getMonth() + 1) + '/' + dateObj.getFullYear() : 'Unknown';
  }

  function coerceNumber(value) {
    const number = Number(value);
    return isNaN(number) ? 0 : number;
  }

  function formatAmount(value) {
    const number = Number(value || 0);

    return number.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatWholeNumber(value) {
    return String(Number(value || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function formatLastRefreshed(value) {
    const dateObj = value ? new Date(value) : new Date();
    if (!dateObj || isNaN(dateObj.getTime())) return 'Last refreshed: Unknown';

    let hours = dateObj.getHours();
    const suffix = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;

    return 'Last refreshed: ' +
      pad2(dateObj.getMonth() + 1) + '/' +
      pad2(dateObj.getDate()) + '/' +
      dateObj.getFullYear() + ' ' +
      hours + ':' +
      pad2(dateObj.getMinutes()) + ' ' +
      suffix;
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

  function pad2(value) {
    return Number(value) < 10 ? '0' + Number(value) : String(value);
  }

  function truncateText(value, maxLength) {
    const text = String(value || '');
    return text.length > maxLength ? text.substring(0, maxLength - 3) + '...' : text;
  }

  function jsString(value) {
    return escAttr(JSON.stringify(String(value == null ? '' : value)));
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

  function buildCss() {
    return `
<style>
.v360{width:100%;box-sizing:border-box;margin:0;padding:18px 22px 24px;font-family:Arial,sans-serif;background:linear-gradient(135deg,#f8fbff 0%,#eef6ff 34%,#f4fbf7 68%,#fff7ed 100%);color:#172033;border:1px solid #d9e2ec;box-shadow:inset 0 1px 0 rgba(255,255,255,.9)}
.topbar{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;background:linear-gradient(135deg,#fff 0%,#eef6ff 52%,#fef3c7 100%);border:1px solid #dce6f2;border-left:5px solid #2563eb;border-radius:8px;padding:16px 18px;margin:0 0 14px;box-shadow:0 8px 22px rgba(15,23,42,.07)}
.topbar h1{margin:0;color:#0f172a;font-size:31px;line-height:1.2;font-weight:800}
.subline{margin-top:5px;color:#475569;font-size:12px;font-weight:800}.refresh{color:#475569;font-size:12px;font-weight:900;white-space:nowrap}
.warning{background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #f4c15d;color:#7c4a03;border-radius:7px;padding:10px 12px;margin-bottom:12px;font-weight:800}
.empty-state{background:linear-gradient(135deg,#fff,#eef6ff);border:1px solid #d6e4f0;border-left:5px solid #22b8c8;border-radius:8px;padding:18px;box-shadow:0 8px 20px rgba(15,23,42,.06)}.empty-state h2{margin:0 0 6px;font-size:18px}.empty-state p{margin:0;color:#555;font-weight:700}
.kpi-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;margin-bottom:12px}.kpi-card{appearance:none;position:relative;overflow:hidden;background:#fff;border:1px solid rgba(203,213,225,.9);border-radius:8px;color:#172033;text-align:center;min-height:86px;padding:13px 10px;font:inherit;cursor:pointer;box-shadow:0 8px 18px rgba(15,23,42,.08);transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}.kpi-card:before{content:"";position:absolute;inset:0;background:linear-gradient(135deg,rgba(255,255,255,.65),rgba(255,255,255,0));pointer-events:none}.kpi-card:hover{transform:translateY(-1px);box-shadow:0 12px 26px rgba(15,23,42,.14);border-color:#93c5fd}
.kpi-card span,.kpi-card b{position:relative;z-index:1}.kpi-card span{display:block;color:#334155;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpi-card b{display:block;color:#0f172a;font-size:25px;line-height:1.1;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-card.blue{background:linear-gradient(135deg,#e0f2fe,#dbeafe 48%,#fff)}.kpi-card.po{background:linear-gradient(135deg,#dbeafe,#bfdbfe 46%,#fff)}.kpi-card.bill{background:linear-gradient(135deg,#ffedd5,#fed7aa 46%,#fff7ed)}.kpi-card.receipt{background:linear-gradient(135deg,#ccfbf1,#99f6e4 46%,#f0fdfa)}.kpi-card.payment{background:linear-gradient(135deg,#ede9fe,#ddd6fe 48%,#faf5ff)}.kpi-card.credit{background:linear-gradient(135deg,#fce7f3,#fbcfe8 48%,#fff1f2)}.kpi-card.neutral{background:linear-gradient(135deg,#f8fafc,#e2e8f0 46%,#fff)}
.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(320px,.85fr);gap:14px;margin-bottom:14px}.dashboard-grid.lower,.dashboard-grid.po-receipt-analysis{grid-template-columns:1fr 1fr}.dashboard-grid.receipt-analysis,.dashboard-grid.bill-analysis{grid-template-columns:1fr}
.panel{background:linear-gradient(180deg,#fff 0%,#f8fbff 100%);border:1px solid #d9e2ec;border-radius:8px;color:#172033;padding:12px;box-shadow:0 10px 24px rgba(15,23,42,.07)}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#f8fbff 0%,#eef6ff 62%,#fff7ed 100%);border-bottom:1px solid #dce6f2;border-radius:8px 8px 0 0;margin:-12px -12px 12px;padding:12px 14px}.panel h2{margin:0;color:#111827;font-size:18px;font-weight:900}.panel-head span{display:block;color:#526171;font-size:12px;font-weight:800;margin-top:3px}
.circle-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;min-height:500px}.txn-circle{width:100%;max-width:820px;height:auto;overflow:visible}.outer-ring{fill:none;stroke:#e2e2e2;stroke-width:25}.txn-slice,.po-status-slice,.receipt-date-slice,.bill-funnel-segment{cursor:pointer;stroke:#f5f5f5;filter:none}.txn-slice{stroke-width:8}.txn-slice:hover,.po-status-slice:hover,.receipt-date-slice:hover,.bill-funnel-segment:hover{opacity:.9}.slice-connector{stroke:#aaa;stroke-width:1.3}.center-disc{fill:#f7f7f7;stroke:#d5d5d5;stroke-width:3}.center-total{font-size:58px;fill:#111;font-weight:900}.center-label{font-size:19px;fill:#555;font-weight:900;letter-spacing:.08em}.circle-label{font-size:19px;fill:#333;font-weight:900}.circle-count{font-size:18px;fill:#555;font-weight:900}
.legend-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;width:100%;max-width:760px}.legend-chip{display:grid;grid-template-columns:12px 1fr auto;gap:8px;align-items:center;background:linear-gradient(135deg,#fff,#f8fbff);border:1px solid #dbe4ef;border-radius:7px;padding:8px 9px;cursor:pointer;text-align:left;font:inherit;min-width:0;box-shadow:0 4px 12px rgba(15,23,42,.05)}.legend-chip:hover,.activity-row:hover,.amount-row:hover{background:linear-gradient(135deg,#fff,#eef6ff);border-color:#93c5fd}.legend-chip span{width:10px;height:10px;border-radius:50%}.legend-chip b{font-size:12px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.legend-chip small{font-size:12px;color:#334155;font-weight:900}
.activity-list{display:flex;flex-direction:column;gap:9px}.activity-row{display:grid;grid-template-columns:10px 1fr auto;align-items:center;gap:10px;text-decoration:none;background:linear-gradient(135deg,#fff 0%,#f8fbff 62%,#fff7ed 100%);border:1px solid #dbe4ef;border-radius:8px;padding:11px 12px;color:#172033;box-shadow:0 6px 14px rgba(15,23,42,.06);transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}.activity-row:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(15,23,42,.12)}.activity-row b{display:block;font-size:14px;color:#111827}.activity-row small{display:block;color:#526171;font-size:11px;font-weight:800;margin-top:3px}.activity-row strong{font-size:13px;color:#111827;font-variant-numeric:tabular-nums}.type-dot{width:10px;height:10px;border-radius:50%;box-shadow:0 0 0 4px rgba(255,255,255,.9),0 0 0 5px rgba(148,163,184,.24)}
.trend-wrap svg,.po-month-wrap svg,.po-status-donut,.receipt-date-donut,.bill-funnel{display:block;width:100%;height:auto;overflow:visible}.trend-wrap svg{min-height:250px}.trend-legend{display:flex;align-items:center;gap:7px;margin:4px 0 0 2px;color:#334155;font-size:12px;font-weight:900}.trend-legend span{display:block;width:12px;height:12px;border-radius:3px;background:linear-gradient(135deg,#fb7185,#facc15 45%,#60a5fa)}.trend-area{fill:url(#monthlyAreaGradient);stroke:none;filter:drop-shadow(0 12px 20px rgba(96,165,250,.16));pointer-events:none}.trend-line-glow{fill:none;stroke:url(#monthlyLineGradient);stroke-width:11;stroke-linecap:round;stroke-linejoin:round;opacity:.24;filter:blur(6px);pointer-events:none}.trend-line{fill:none;stroke:url(#monthlyLineGradient);stroke-width:4.2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(0 0 9px rgba(96,165,250,.35));pointer-events:none}.trend-point-glow{pointer-events:none}.trend-point-glow-wide{fill:#fb923c;opacity:.32;filter:blur(7px)}.trend-point-glow-tight{fill:#facc15;opacity:.68;filter:blur(3px)}.trend-point{fill:#fff;stroke:#fb923c;stroke-width:3.2;cursor:pointer;filter:drop-shadow(0 0 7px rgba(255,255,255,.95)) drop-shadow(0 0 13px rgba(251,146,60,.72))}.trend-hit{fill:transparent;cursor:pointer}.trend-point:hover{fill:#fff7ed;stroke:#60a5fa;filter:drop-shadow(0 0 8px rgba(255,255,255,.95)) drop-shadow(0 0 15px rgba(96,165,250,.75))}.trend-value{font-size:11px;fill:#172033;font-weight:900}.po-month-wrap svg,.receipt-date-donut{min-height:260px}.trend-bar{opacity:.9;cursor:pointer;filter:drop-shadow(0 4px 8px rgba(15,23,42,.12))}.trend-bar:hover{opacity:1}.po-month-bar{opacity:1;stroke:rgba(255,255,255,.62);stroke-width:1.2;filter:drop-shadow(0 0 7px rgba(255,255,255,.9)) drop-shadow(0 8px 13px rgba(15,23,42,.13))}.po-month-bar:hover{filter:drop-shadow(0 0 9px rgba(255,255,255,.95)) drop-shadow(0 10px 16px rgba(15,23,42,.18))}.po-bar-glow-wide{opacity:.46;filter:blur(13px);pointer-events:none}.po-bar-bg-shadow{opacity:.92;filter:blur(8px);pointer-events:none}.po-bar-base-shadow{filter:blur(4px);pointer-events:none}.po-bar-highlight{fill:rgba(255,255,255,.36);pointer-events:none}.grid-line{stroke:#dbe3ed;stroke-width:1}.axis-line{stroke:#94a3b8;stroke-width:1}.axis-label{font-size:10px;fill:#526171;font-weight:800}.bar-value{font-size:10px;fill:#172033;font-weight:900}
.po-status-wrap,.receipt-date-wrap,.bill-funnel-wrap{display:flex;align-items:center;justify-content:center}.po-status-wrap{min-height:250px;padding:2px 0 0;gap:14px;flex-wrap:wrap}.receipt-date-wrap{min-height:300px;padding:8px 0;gap:14px;flex-wrap:wrap}.bill-funnel-wrap{min-height:180px;padding:8px 0}.po-status-donut{max-width:300px;min-width:220px;min-height:0;flex:0 1 300px}.bill-funnel{max-width:560px}.po-status-glow{opacity:.42;filter:blur(11px);pointer-events:none;transform:translateY(8px)}.po-status-slice{stroke:#fff;stroke-width:8;cursor:pointer;filter:drop-shadow(0 7px 10px rgba(15,23,42,.08));transition:opacity .12s ease}.po-status-slice:hover{opacity:.94}.po-status-hole{fill:rgba(255,255,255,.97);stroke:rgba(226,232,240,.95);stroke-width:1.5;filter:drop-shadow(0 2px 9px rgba(96,165,250,.18))}.po-status-label{font-size:13px;fill:#333;font-weight:900}.po-status-count{font-size:12px;fill:#555;font-weight:800}.po-status-center-total{font-size:31px;fill:#60a5fa;font-weight:900}.po-status-center-label{font-size:14px;fill:#8bbcff;font-weight:800;letter-spacing:0}.po-status-legend{display:flex;flex-direction:column;gap:7px;min-width:170px;max-width:240px;flex:1 1 180px}.po-status-legend-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:8px;border:1px solid #dbe4ef;border-radius:7px;background:linear-gradient(135deg,#fff,#f8fbff);padding:8px 9px;text-align:left;font:inherit;cursor:pointer;box-shadow:0 4px 10px rgba(15,23,42,.05)}.po-status-legend-row:hover{background:linear-gradient(135deg,#fff,#eef6ff);border-color:#93c5fd}.po-status-legend-row span{width:10px;height:10px;border-radius:50%;box-shadow:0 0 9px rgba(96,165,250,.28)}.po-status-legend-row b{font-size:12px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.po-status-legend-row small{font-size:11px;color:#334155;font-weight:900;white-space:nowrap}.receipt-date-donut{max-width:300px;min-width:230px;flex:0 1 300px}.receipt-date-slice{stroke-width:3}.receipt-date-legend{display:flex;flex-direction:column;gap:7px;min-width:170px;max-width:230px;flex:1 1 180px}.receipt-date-legend-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:8px;border:1px solid #dbe4ef;border-radius:7px;background:linear-gradient(135deg,#fff,#f8fbff);padding:8px 9px;text-align:left;font:inherit;cursor:pointer;box-shadow:0 4px 10px rgba(15,23,42,.05)}.receipt-date-legend-row:hover{background:linear-gradient(135deg,#fff,#eef6ff);border-color:#93c5fd}.receipt-date-legend-row span{width:10px;height:10px;border-radius:50%}.receipt-date-legend-row b{font-size:12px;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.receipt-date-legend-row small{font-size:11px;color:#334155;font-weight:900;white-space:nowrap}.circle-label.small{font-size:12px;font-family:Arial,sans-serif}.circle-count.small{font-size:11px;font-family:Arial,sans-serif}.receipt-center-total{font-size:28px;fill:#111;font-weight:900}.receipt-center-label{font-size:11px;fill:#555;font-weight:900;letter-spacing:.08em}.bill-funnel-shadow{opacity:.28;filter:blur(9px);pointer-events:none}.bill-funnel-segment{stroke-width:3;filter:drop-shadow(0 5px 8px rgba(15,23,42,.12))}.bill-funnel-label{font-size:13px;fill:#333;font-weight:900}.bill-funnel-status{font-size:10px;fill:#333;font-weight:800}.circle-label,.circle-count,.bar-value,.trend-value,.axis-label,.po-status-label,.po-status-count,.bill-funnel-label,.bill-funnel-status{pointer-events:none}
.amount-bars{display:flex;flex-direction:column;gap:9px;margin-top:4px}.amount-row{display:grid;grid-template-columns:130px 1fr 90px;align-items:center;gap:10px;background:linear-gradient(135deg,#fff 0%,#f8fbff 70%,#ecfeff 100%);border:1px solid #dbe4ef;border-radius:8px;padding:10px 11px;font:inherit;text-align:left;cursor:pointer;box-shadow:0 5px 14px rgba(15,23,42,.06);transition:transform .12s ease,box-shadow .12s ease,border-color .12s ease}.amount-row:hover{transform:translateY(-1px);box-shadow:0 9px 20px rgba(15,23,42,.12)}.amount-label{font-size:12px;font-weight:900;color:#1f2937;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.amount-track{height:10px;background:linear-gradient(90deg,#e2e8f0,#f1f5f9);border-radius:999px;overflow:hidden;box-shadow:inset 0 1px 2px rgba(15,23,42,.12)}.amount-track span{display:block;height:100%;border-radius:999px}.amount-row b{text-align:right;color:#111827;font-size:12px;font-variant-numeric:tabular-nums}
.empty-chart,.empty-list{min-height:170px;display:flex;align-items:center;justify-content:center;text-align:center;background:linear-gradient(135deg,#fff,#f8fbff);border:1px dashed #b9c8da;border-radius:8px;color:#526171;font-weight:900}.empty-chart.short{min-height:220px}
.table-panel{padding-bottom:10px}.table-actions{display:flex;gap:8px}.btn{background:linear-gradient(135deg,#2563eb 0%,#14b8a6 100%);border:0;border-radius:7px;color:#fff;padding:8px 12px;font-weight:900;cursor:pointer;box-shadow:0 7px 16px rgba(37,99,235,.24);transition:transform .12s ease,box-shadow .12s ease}.btn:hover{background:linear-gradient(135deg,#1d4ed8 0%,#0f766e 100%);transform:translateY(-1px);box-shadow:0 10px 22px rgba(37,99,235,.32)}.table-scroll{overflow:auto;max-height:650px;border-top:1px solid #dbe4ef;border-radius:0 0 8px 8px}.txn-table{width:100%;border-collapse:collapse;font-size:12px}.txn-table th{position:sticky;top:0;z-index:2;text-align:left;background:linear-gradient(135deg,#e0f2fe,#eef2ff 55%,#f8fbff);color:#172033;border-bottom:1px solid #c7d7ea;padding:10px;font-weight:900;white-space:nowrap}.txn-table th button{border:0;background:transparent;padding:0;font:inherit;font-weight:900;color:#172033;cursor:pointer}.txn-table th button:hover{color:#2563eb}.txn-table td{border-bottom:1px solid #e2e8f0;padding:9px 10px;vertical-align:top;color:#1f2937}.txn-table tbody tr:nth-child(even) td{background:#f8fbff}.txn-table tbody tr:hover td{background:#eef6ff}.table-link{color:#2563eb;font-weight:900;text-decoration:none}.table-link:hover{text-decoration:underline}.amount-cell{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.type-pill{display:inline-block;border-radius:999px;padding:4px 8px;font-weight:900;font-size:11px;white-space:nowrap;box-shadow:inset 0 0 0 1px rgba(255,255,255,.55)}.empty-row{text-align:center!important;color:#526171;font-weight:900;padding:30px!important}.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;border-top:1px solid #dbe4ef;padding-top:10px;margin-top:10px;color:#526171;font-size:12px;font-weight:900}
@media(max-width:1200px){.kpi-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.dashboard-grid,.dashboard-grid.lower,.dashboard-grid.po-receipt-analysis{grid-template-columns:1fr}.legend-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.v360{padding:10px}.topbar{flex-direction:column;align-items:flex-start}.refresh{white-space:normal}.kpi-grid,.legend-grid{grid-template-columns:1fr}.po-status-wrap,.receipt-date-wrap{flex-direction:column}.po-status-legend,.receipt-date-legend{width:100%;max-width:320px}.amount-row{grid-template-columns:1fr}.amount-row b{text-align:left}.pager{align-items:stretch;flex-direction:column}.btn{width:100%}}
</style>`;
  }

  function buildScript() {
    return `
<script>
  var visibleRows = ${JSON.stringify(CONFIG.tablePageSize)};
  var pageSize = ${JSON.stringify(CONFIG.tablePageSize)};
  var sortState = {};
  var activeClientFilter = {};

  function setTypeFilter(type){
    var field = document.getElementById('custpage_txntype');
    if(field){
      field.value = type || 'ALL';
      submitDashboardForm();
      return;
    }
    filterRowsByType(type || 'ALL');
  }

  function submitDashboardForm(){
    var form = document.forms && document.forms.length ? document.forms[0] : null;
    var resetField = document.getElementById('custpage_reset');
    if(resetField) resetField.value = '';
    if(form) form.submit();
  }

  function resetDashboardForm(){
    var form = document.forms && document.forms.length ? document.forms[0] : null;
    var fields = {
      custpage_vendor: '',
      custpage_txntype: 'ALL',
      custpage_datefrom: '',
      custpage_dateto: '',
      custpage_search: '',
      custpage_reset: 'T'
    };

    Object.keys(fields).forEach(function(id){
      var field = document.getElementById(id);
      if(field) field.value = fields[id];
    });

    activeClientFilter = {};
    visibleRows = pageSize;
    if(form) form.submit();
  }

  function bindDashboardReset(){
    var form = document.forms && document.forms.length ? document.forms[0] : null;

    if(form){
      form.addEventListener('reset', function(e){
        e.preventDefault();
        resetDashboardForm();
      });
    }

    Array.prototype.slice.call(document.querySelectorAll('input[type="reset"],button[type="reset"]')).forEach(function(button){
      button.addEventListener('click', function(e){
        e.preventDefault();
        resetDashboardForm();
      });
    });
  }

  function filterRowsByType(type){
    applyClientFilter(type || 'ALL', '', '', '');
  }

  function applyClientFilter(type, status, month, date){
    activeClientFilter = {
      type: type === 'ALL' ? '' : String(type || ''),
      status: String(status || ''),
      month: String(month || ''),
      date: String(date || ''),
      search: getSearchFilterValue()
    };
    visibleRows = pageSize;
    updatePaging();
    var panel = document.querySelector('.table-panel');
    if(panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function applySearchFilter(){
    activeClientFilter.search = getSearchFilterValue();
    visibleRows = pageSize;
    updatePaging();
  }

  function getSearchFilterValue(){
    var field = document.getElementById('custpage_search');
    return field ? String(field.value || '').toLowerCase().trim() : '';
  }

  function getRows(){
    var table = document.getElementById('transactionTable');
    if(!table || !table.tBodies.length) return [];
    return Array.prototype.slice.call(table.tBodies[0].rows).filter(function(row){
      return row.getAttribute('data-row-index') !== null;
    });
  }

  function rowMatchesClientFilter(row){
    if(activeClientFilter.type && row.getAttribute('data-type') !== activeClientFilter.type) return false;
    if(activeClientFilter.status && row.getAttribute('data-status') !== activeClientFilter.status) return false;
    if(activeClientFilter.month && row.getAttribute('data-month') !== activeClientFilter.month) return false;
    if(activeClientFilter.date && row.getAttribute('data-tran-date') !== activeClientFilter.date) return false;
    if(activeClientFilter.search && String(row.getAttribute('data-search') || '').indexOf(activeClientFilter.search) < 0) return false;
    return true;
  }

  function hasActiveClientFilter(){
    return !!(activeClientFilter.type || activeClientFilter.status || activeClientFilter.month || activeClientFilter.date || activeClientFilter.search);
  }

  function updatePaging(){
    var rows = getRows();
    var filteredRows = rows.filter(rowMatchesClientFilter);
    visibleRows = Math.min(visibleRows, filteredRows.length);
    var visibleMap = {};

    filteredRows.slice(0, visibleRows).forEach(function(row){
      visibleMap[row.getAttribute('data-row-index')] = true;
    });

    rows.forEach(function(row){
      row.style.display = visibleMap[row.getAttribute('data-row-index')] ? '' : 'none';
    });

    var count = document.getElementById('rowCount');
    if(count) count.textContent = filteredRows.length ? visibleRows + ' of ' + filteredRows.length + ' transactions shown' : '0 transactions shown';

    var pagerText = document.getElementById('pagerText');
    if(pagerText) pagerText.textContent = visibleRows + ' of ' + filteredRows.length + ' shown';

    var loadMore = document.getElementById('loadMoreBtn');
    if(loadMore){
      var remaining = Math.max(0, filteredRows.length - visibleRows);
      loadMore.style.display = remaining > 0 ? '' : 'none';
      loadMore.textContent = 'Load Next ' + Math.min(pageSize, remaining);
    }
  }

  function loadMoreRows(){
    var rows = getRows().filter(rowMatchesClientFilter);
    visibleRows = Math.min(rows.length, visibleRows + pageSize);
    updatePaging();
  }

  function clearClientFilter(){
    if(hasActiveClientFilter()){
      activeClientFilter = {};
      var searchField = document.getElementById('custpage_search');
      if(searchField) searchField.value = '';
      visibleRows = pageSize;
      updatePaging();
      return;
    }

    var field = document.getElementById('custpage_txntype');
    if(field && field.value !== 'ALL'){
      field.value = 'ALL';
      submitDashboardForm();
      return;
    }
    visibleRows = pageSize;
    updatePaging();
  }

  function sortTable(columnIndex, type){
    var table = document.getElementById('transactionTable');
    if(!table || !table.tBodies.length) return;

    var tbody = table.tBodies[0];
    var rows = getRows();
    var key = String(columnIndex);
    var direction = sortState[key] === 'asc' ? 'desc' : 'asc';
    sortState = {};
    sortState[key] = direction;

    rows.sort(function(a, b){
      var aValue = getSortValue(a, columnIndex, type);
      var bValue = getSortValue(b, columnIndex, type);
      if(aValue < bValue) return direction === 'asc' ? -1 : 1;
      if(aValue > bValue) return direction === 'asc' ? 1 : -1;
      return 0;
    });

    rows.forEach(function(row){
      tbody.appendChild(row);
    });

    updatePaging();
  }

  function getSortValue(row, columnIndex, type){
    var cell = row.cells[columnIndex];
    var value = cell ? (cell.getAttribute('data-sort-value') || cell.textContent || '') : '';
    if(type === 'number' || type === 'date') return Number(value) || 0;
    return String(value).toLowerCase();
  }

  var vendorField = document.getElementById('custpage_vendor');
  if(vendorField){
    vendorField.addEventListener('change', function(){
      if(vendorField.value) submitDashboardForm();
    });
  }

  var searchField = document.getElementById('custpage_search');
  if(searchField){
    searchField.addEventListener('input', applySearchFilter);
    searchField.addEventListener('change', applySearchFilter);
    searchField.addEventListener('keydown', function(e){
      if(e.key === 'Enter'){
        e.preventDefault();
        applySearchFilter();
      }
    });
  }

  bindDashboardReset();
  updatePaging();
</script>`;
  }

  return { onRequest };
});
