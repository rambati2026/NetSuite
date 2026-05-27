/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * Ramakrishna Ambati
 * Date : Apr/12/2026
 * Script for vendor Email Template Delivery activity list
 */
define(['N/search', 'N/file', 'N/log', 'N/ui/serverWidget', 'N/url', 'N/format'], (
  search,
  file,
  log,
  serverWidget,
  url,
  format
) => {
  const CSV_NAME = 'active_vendors_activity_report.csv';
  const MAX_PREVIEW_ROWS = 1000;

  const SCRIPT_ID = 'customscript_psiq_vendor_activity_report';
  const DEPLOYMENT_ID = 'customdeploy_psiq_vendor_activity_report';

  const FIELD_CONFIG = [
    { key: 'vendor_id', label: 'Vendor ID' },
    { key: 'vendor_name', label: 'Vendor Name' },
    { key: 'vendor_creation_date', label: 'Vendor Creation Date' },
    { key: 'latest_po_date', label: 'Latest PO Date' },
    { key: 'last_invoice_date', label: 'Last Invoice Date' },
    { key: 'latest_item_receipt_date', label: 'Latest Item Receipt Date' },
    { key: 'latest_payment_date', label: 'Latest Payment Date' },
    { key: 'latest_activity_date', label: 'Latest Activity Date' },
    { key: 'days_since_last_activity', label: 'Days Since Last Activity' }
  ];

  const TRANSACTION_CONFIG = [
    { type: 'PurchOrd', targetField: 'latest_po_date' },
    { type: 'VendBill', targetField: 'last_invoice_date' },
    { type: 'ItemRcpt', targetField: 'latest_item_receipt_date' },
    { type: 'VendPymt', targetField: 'latest_payment_date' }
  ];

  const DAYS_RANGE_OPTIONS = [
    { value: '', text: '- All -' },
    { value: '0_365', text: '0 - 365 days' },
    { value: '366_1000', text: '366 - 1000 days' },
    { value: '1001_PLUS', text: '1001+ days' },
    { value: 'NO_ACTIVITY', text: 'No activity' }
  ];

  const THRESHOLD_OPTIONS = [
    { value: '', text: '- None -' },
    { value: '30', text: '> 30 days' },
    { value: '90', text: '> 90 days' },
    { value: '180', text: '> 180 days' },
    { value: '365', text: '> 365 days' },
    { value: '730', text: '> 730 days' },
    { value: '1000', text: '> 1000 days' }
  ];

  const DATE_FIELDS = {
    vendor_creation_date: true,
    latest_po_date: true,
    last_invoice_date: true,
    latest_item_receipt_date: true,
    latest_payment_date: true,
    latest_activity_date: true
  };

  const SORTABLE_DATE_FIELDS = {
    vendor_creation_date: true,
    latest_po_date: true
  };

  function safeText(value) {
    return value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return safeText(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateBold2026(value) {
    const text = safeText(value);

    if (text.indexOf('2026') !== -1) {
      return '<strong>' + escapeHtml(text) + '</strong>';
    }

    return escapeHtml(text);
  }

  function csvEscape(value) {
    if (value == null) {
      return '';
    }
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  function toInt(value) {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  function normalizeSortBy(value) {
    const sortBy = safeText(value);
    return SORTABLE_DATE_FIELDS[sortBy] ? sortBy : '';
  }

  function normalizeSortDir(value) {
    return safeText(value).toLowerCase() === 'asc' ? 'asc' : 'desc';
  }

  function parseDateMs(value) {
    if (!value) {
      return null;
    }

    const d = new Date(value);
    if (isNaN(d.getTime())) {
      return null;
    }

    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function formatDateOnly(value) {
    if (!value) {
      return '';
    }

    try {
      const parsed = format.parse({
        value: value,
        type: format.Type.DATETIMETZ
      });

      return format.format({
        value: parsed,
        type: format.Type.DATE
      });
    } catch (e) {
      try {
        const parsed = format.parse({
          value: value,
          type: format.Type.DATE
        });

        return format.format({
          value: parsed,
          type: format.Type.DATE
        });
      } catch (err) {
        return safeText(value).split(' ')[0];
      }
    }
  }

  function getAllResults(searchObj) {
    const results = [];
    const pagedData = searchObj.runPaged({ pageSize: 1000 });

    for (let i = 0; i < pagedData.pageRanges.length; i += 1) {
      const page = pagedData.fetch({ index: pagedData.pageRanges[i].index });
      for (let j = 0; j < page.data.length; j += 1) {
        results.push(page.data[j]);
      }
    }

    return results;
  }

  function buildVendorMap() {
    const vendorMap = Object.create(null);

    const vendorSearch = search.create({
      type: search.Type.VENDOR,
      filters: [['isinactive', 'is', 'F']],
      columns: ['internalid', 'entityid', 'datecreated']
    });

    const results = getAllResults(vendorSearch);

    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const id = r.getValue('internalid');

      if (!id) {
        continue;
      }

      vendorMap[id] = {
        vendor_id: safeText(id),
        vendor_name: safeText(r.getValue('entityid')),
        vendor_creation_date: formatDateOnly(r.getValue('datecreated')),
        latest_po_date: '',
        last_invoice_date: '',
        latest_item_receipt_date: '',
        latest_payment_date: '',
        latest_activity_date: '',
        days_since_last_activity: ''
      };
    }

    return vendorMap;
  }

  function applyTransactionData(vendorMap, type, field) {
    const txnSearch = search.create({
      type: search.Type.TRANSACTION,
      filters: [
        ['type', 'anyof', type],
        'AND',
        ['mainline', 'is', 'T'],
        'AND',
        ['entity', 'noneof', '@NONE@']
      ],
      columns: [
        search.createColumn({ name: 'entity', summary: search.Summary.GROUP }),
        search.createColumn({ name: 'trandate', summary: search.Summary.MAX })
      ]
    });

    const results = getAllResults(txnSearch);

    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const vendorId = r.getValue({
        name: 'entity',
        summary: search.Summary.GROUP
      });

      if (!vendorId || !vendorMap[vendorId]) {
        continue;
      }

      vendorMap[vendorId][field] = safeText(
        r.getValue({
          name: 'trandate',
          summary: search.Summary.MAX
        })
      );
    }
  }

  function enrich(rows) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const dates = [
        row.latest_po_date,
        row.last_invoice_date,
        row.latest_item_receipt_date,
        row.latest_payment_date
      ];

      let latestRaw = '';
      let latestMs = null;

      for (let j = 0; j < dates.length; j += 1) {
        const ms = parseDateMs(dates[j]);

        if (ms != null && (latestMs == null || ms > latestMs)) {
          latestMs = ms;
          latestRaw = dates[j];
        }
      }

      row.latest_activity_date = latestRaw;
      row.days_since_last_activity =
        latestMs == null ? '' : String(Math.floor((todayMs - latestMs) / 86400000));
    }

    return rows;
  }

  function runReport() {
    const vendorMap = buildVendorMap();

    for (let i = 0; i < TRANSACTION_CONFIG.length; i += 1) {
      applyTransactionData(
        vendorMap,
        TRANSACTION_CONFIG[i].type,
        TRANSACTION_CONFIG[i].targetField
      );
    }

    const rows = enrich(Object.values(vendorMap));

    rows.sort(function(a, b) {
      const nameA = (a.vendor_name || '').toLowerCase();
      const nameB = (b.vendor_name || '').toLowerCase();

      if (nameA < nameB) return -1;
      if (nameA > nameB) return 1;
      return 0;
    });

    return rows;
  }

  function compareVendorName(a, b) {
    const nameA = (a.vendor_name || '').toLowerCase();
    const nameB = (b.vendor_name || '').toLowerCase();

    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  }

  function compareDates(a, b, field, direction) {
    const aMs = parseDateMs(a[field]);
    const bMs = parseDateMs(b[field]);

    if (aMs == null && bMs == null) {
      return 0;
    }

    if (aMs == null) {
      return 1;
    }

    if (bMs == null) {
      return -1;
    }

    if (aMs === bMs) {
      return 0;
    }

    if (direction === 'asc') {
      return aMs < bMs ? -1 : 1;
    }

    return aMs > bMs ? -1 : 1;
  }

  function applySort(rows, filters) {
    const sortBy = normalizeSortBy(filters.sortBy);

    if (!sortBy) {
      return rows;
    }

    const sortDir = normalizeSortDir(filters.sortDir);

    rows.sort(function(a, b) {
      const dateCompare = compareDates(a, b, sortBy, sortDir);

      if (dateCompare !== 0) {
        return dateCompare;
      }

      return compareVendorName(a, b);
    });

    return rows;
  }

  function matchesVendor(row, vendorFilter) {
    if (!vendorFilter) {
      return true;
    }

    const filter = vendorFilter.toLowerCase();
    return (
      row.vendor_id.toLowerCase().indexOf(filter) !== -1 ||
      row.vendor_name.toLowerCase().indexOf(filter) !== -1
    );
  }

  function matchesDaysRange(row, daysRange) {
    if (!daysRange) {
      return true;
    }

    const days = toInt(row.days_since_last_activity);

    if (daysRange === 'NO_ACTIVITY') {
      return row.days_since_last_activity === '';
    }

    if (days == null) {
      return false;
    }

    if (daysRange === '0_365') {
      return days >= 0 && days <= 365;
    }

    if (daysRange === '366_1000') {
      return days >= 366 && days <= 1000;
    }

    if (daysRange === '1001_PLUS') {
      return days >= 1001;
    }

    return true;
  }

  function matchesThreshold(row, thresholdValue) {
    if (!thresholdValue) {
      return true;
    }

    const threshold = toInt(thresholdValue);
    const days = toInt(row.days_since_last_activity);

    if (threshold == null || days == null) {
      return false;
    }

    return days > threshold;
  }

  function applyFilters(rows, filters) {
    const filtered = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];

      if (!matchesVendor(row, filters.vendor)) {
        continue;
      }

      if (!matchesDaysRange(row, filters.daysRange)) {
        continue;
      }

      if (!matchesThreshold(row, filters.threshold)) {
        continue;
      }

      filtered.push(row);
    }

    return filtered;
  }

  function getActivityCounts(rows) {
    const counts = {
      range_0_365: 0,
      range_366_1000: 0,
      range_1001_plus: 0,
      no_activity: 0,
      total: rows.length
    };

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const days = toInt(row.days_since_last_activity);

      if (row.days_since_last_activity === '') {
        counts.no_activity += 1;
      } else if (days != null && days >= 0 && days <= 365) {
        counts.range_0_365 += 1;
      } else if (days != null && days >= 366 && days <= 1000) {
        counts.range_366_1000 += 1;
      } else if (days != null && days >= 1001) {
        counts.range_1001_plus += 1;
      }
    }

    return counts;
  }

  function getPercent(count, total) {
    if (!total) {
      return '0.0';
    }
    return ((count / total) * 100).toFixed(1);
  }

  function buildCsv(rows) {
    const lines = [[
      'Vendor ID',
      'Vendor Name',
      'Vendor Creation Date',
      'Latest PO Date',
      'Last Invoice Date',
      'Latest Item Receipt Date',
      'Latest Payment Date',
      'Latest Activity Date',
      'Days Since Last Activity'
    ].join(',')];

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      lines.push([
        csvEscape(r.vendor_id),
        csvEscape(r.vendor_name),
        csvEscape(r.vendor_creation_date),
        csvEscape(r.latest_po_date),
        csvEscape(r.last_invoice_date),
        csvEscape(r.latest_item_receipt_date),
        csvEscape(r.latest_payment_date),
        csvEscape(r.latest_activity_date),
        csvEscape(r.days_since_last_activity)
      ].join(','));
    }

    return lines.join('\n');
  }

  function writeCsv(context, rows) {
    const f = file.create({
      name: CSV_NAME,
      fileType: file.Type.CSV,
      contents: buildCsv(rows)
    });

    context.response.writeFile({
      file: f,
      isInline: false
    });
  }

  function getTrafficLightHtml(value) {
    const days = toInt(value);

    if (value === '') {
      return '<span style="' +
        'display:inline-block;' +
        'padding:3px 10px;' +
        'border-radius:12px;' +
        'background:#f3f4f6;' +
        'color:#6b7280;' +
        'font-weight:600;' +
      '">No activity</span>';
    }

    if (days != null && days <= 365) {
      return '<span style="' +
        'display:inline-block;' +
        'min-width:54px;' +
        'text-align:center;' +
        'padding:3px 10px;' +
        'border-radius:12px;' +
        'background:#e9f7ef;' +
        'color:#1e7e34;' +
        'font-weight:700;' +
      '">' + escapeHtml(value) + '</span>';
    }

    if (days != null && days <= 1000) {
      return '<span style="' +
        'display:inline-block;' +
        'min-width:54px;' +
        'text-align:center;' +
        'padding:3px 10px;' +
        'border-radius:12px;' +
        'background:#fff8db;' +
        'color:#8a6d00;' +
        'font-weight:700;' +
      '">' + escapeHtml(value) + '</span>';
    }

    return '<span style="' +
      'display:inline-block;' +
      'min-width:54px;' +
      'text-align:center;' +
      'padding:3px 10px;' +
      'border-radius:12px;' +
      'background:#fdecec;' +
      'color:#b00020;' +
      'font-weight:700;' +
    '">' + escapeHtml(value) + '</span>';
  }

  function addFilterFields(form, filters) {
    form.addFieldGroup({
      id: 'custpage_filter_group',
      label: 'Filters'
    });

    const vendorField = form.addField({
      id: 'custpage_filter_vendor',
      type: serverWidget.FieldType.TEXT,
      label: 'Vendor',
      container: 'custpage_filter_group'
    });
    vendorField.defaultValue = safeText(filters.vendor);

    const sortByField = form.addField({
      id: 'custpage_sort_by',
      type: serverWidget.FieldType.TEXT,
      label: 'Sort By',
      container: 'custpage_filter_group'
    });
    sortByField.defaultValue = safeText(filters.sortBy);
    sortByField.updateDisplayType({
      displayType: serverWidget.FieldDisplayType.HIDDEN
    });

    const sortDirField = form.addField({
      id: 'custpage_sort_dir',
      type: serverWidget.FieldType.TEXT,
      label: 'Sort Direction',
      container: 'custpage_filter_group'
    });
    sortDirField.defaultValue = safeText(filters.sortDir);
    sortDirField.updateDisplayType({
      displayType: serverWidget.FieldDisplayType.HIDDEN
    });

    const daysRangeField = form.addField({
      id: 'custpage_filter_days_range',
      type: serverWidget.FieldType.SELECT,
      label: 'Days Since Activity Range',
      container: 'custpage_filter_group'
    });

    for (let i = 0; i < DAYS_RANGE_OPTIONS.length; i += 1) {
      daysRangeField.addSelectOption({
        value: DAYS_RANGE_OPTIONS[i].value,
        text: DAYS_RANGE_OPTIONS[i].text,
        isSelected: DAYS_RANGE_OPTIONS[i].value === filters.daysRange
      });
    }

    const thresholdField = form.addField({
      id: 'custpage_filter_threshold',
      type: serverWidget.FieldType.SELECT,
      label: 'Inactive Threshold',
      container: 'custpage_filter_group'
    });

    thresholdField.updateBreakType({
      breakType: serverWidget.FieldBreakType.STARTCOL
    });

    for (let i = 0; i < THRESHOLD_OPTIONS.length; i += 1) {
      thresholdField.addSelectOption({
        value: THRESHOLD_OPTIONS[i].value,
        text: THRESHOLD_OPTIONS[i].text,
        isSelected: THRESHOLD_OPTIONS[i].value === filters.threshold
      });
    }

    form.addSubmitButton({
      label: 'Apply Filters'
    });

    const resetUrl = url.resolveScript({
      scriptId: SCRIPT_ID,
      deploymentId: DEPLOYMENT_ID
    });

    const resetHtml = form.addField({
      id: 'custpage_reset_filters_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: ' ',
      container: 'custpage_filter_group'
    });

    resetHtml.defaultValue =
      '<div style="margin-top:8px;">' +
        '<a href="' + escapeHtml(resetUrl) + '" style="' +
          'display:inline-block;' +
          'padding:8px 14px;' +
          'background:#6b7280;' +
          'color:#ffffff;' +
          'text-decoration:none;' +
          'border-radius:4px;' +
          'font-weight:600;' +
        '">Reset Filters</a>' +
      '</div>';
  }

  function buildDownloadUrl(filters) {
    return url.resolveScript({
      scriptId: SCRIPT_ID,
      deploymentId: DEPLOYMENT_ID,
      params: {
        action: 'download',
        vendor: safeText(filters.vendor),
        daysrange: safeText(filters.daysRange),
        threshold: safeText(filters.threshold),
        sort_by: safeText(filters.sortBy),
        sort_dir: safeText(filters.sortDir)
      }
    });
  }

  function buildBadgeUrl(filters, daysRangeValue) {
    return url.resolveScript({
      scriptId: SCRIPT_ID,
      deploymentId: DEPLOYMENT_ID,
      params: {
        vendor: safeText(filters.vendor),
        daysrange: safeText(daysRangeValue),
        threshold: safeText(filters.threshold),
        sort_by: safeText(filters.sortBy),
        sort_dir: safeText(filters.sortDir)
      }
    });
  }

  function buildSortUrl(filters, fieldKey) {
    const currentSortBy = normalizeSortBy(filters.sortBy);
    const currentSortDir = normalizeSortDir(filters.sortDir);
    const nextSortDir = currentSortBy === fieldKey && currentSortDir === 'desc' ? 'asc' : 'desc';

    return url.resolveScript({
      scriptId: SCRIPT_ID,
      deploymentId: DEPLOYMENT_ID,
      params: {
        vendor: safeText(filters.vendor),
        daysrange: safeText(filters.daysRange),
        threshold: safeText(filters.threshold),
        sort_by: fieldKey,
        sort_dir: nextSortDir
      }
    });
  }

  function buildBadge(label, daysRangeValue, bg, activeBg, color, beforeCount, afterCount, totalAfter, filters, selectedRange) {
    const href = buildBadgeUrl(filters, daysRangeValue);
    const pct = getPercent(afterCount, totalAfter);
    const isActive = selectedRange === daysRangeValue;

    const border = isActive ? '2px solid #111827' : '1px solid rgba(0,0,0,0.08)';
    const shadow = isActive ? 'box-shadow:0 4px 10px rgba(0,0,0,0.18);' : 'box-shadow:0 1px 2px rgba(0,0,0,0.08);';
    const scale = isActive ? 'transform:scale(1.05);' : '';
    const opacity = isActive ? 'opacity:1;' : 'opacity:0.85;';
    const background = isActive ? activeBg : bg;

    return '' +
      '<a href="' + escapeHtml(href) + '" style="' +
        'display:inline-block;' +
        'padding:8px 12px;' +
        'background:' + background + ';' +
        'color:' + color + ';' +
        'font-weight:700;' +
        'border-radius:12px;' +
        'text-decoration:none;' +
        'line-height:1.4;' +
        'transition:all 0.15s ease;' +
        'border:' + border + ';' +
        shadow +
        scale +
        opacity +
      '">' +
        '<div>' + escapeHtml(label) + (isActive ? ' ✓' : '') + '</div>' +
        '<div style="font-size:11px; margin-top:2px;">' +
          'Filtered: ' + escapeHtml(afterCount) + ' (' + escapeHtml(pct) + '%)' +
        '</div>' +
        '<div style="font-size:11px; opacity:0.85;">' +
          'All: ' + escapeHtml(beforeCount) +
        '</div>' +
      '</a>';
  }

  function buildSummaryHtml(allRowsCount, filteredRowsCount, downloadUrl, allCounts, filteredCounts, filters) {
    return '' +
      '<div style="padding:10px 0 14px 0;">' +
        '<div style="font-size:18px; font-weight:700; color:#111827; margin-bottom:6px;">' +
          'Total rows: ' + escapeHtml(filteredRowsCount) +
        '</div>' +
        '<div style="font-size:12px; color:#6b7280; margin-bottom:12px;">' +
          'Before filters: ' + escapeHtml(allRowsCount) +
        '</div>' +
        '<div style="margin-bottom:14px;">' +
          '<a href="' + escapeHtml(downloadUrl) + '" style="' +
            'display:inline-block;' +
            'background:#206efc;' +
            'color:#ffffff;' +
            'padding:10px 16px;' +
            'text-decoration:none;' +
            'border-radius:4px;' +
            'font-weight:600;' +
          '">Download CSV</a>' +
        '</div>' +
        '<div style="font-size:12px; color:#4b5563; margin-bottom:8px; font-weight:600;">' +
          'Click a badge to filter by activity bucket' +
        '</div>' +
        '<div style="display:flex; gap:12px; flex-wrap:wrap;">' +
          buildBadge(
            '0-365 days',
            '0_365',
            '#e9f7ef',
            '#cfeeda',
            '#1e7e34',
            allCounts.range_0_365,
            filteredCounts.range_0_365,
            filteredRowsCount,
            filters,
            filters.daysRange
          ) +
          buildBadge(
            '366-1000 days',
            '366_1000',
            '#fff8db',
            '#f5ecb7',
            '#8a6d00',
            allCounts.range_366_1000,
            filteredCounts.range_366_1000,
            filteredRowsCount,
            filters,
            filters.daysRange
          ) +
          buildBadge(
            '1001+ days',
            '1001_PLUS',
            '#fdecec',
            '#f7cfcf',
            '#b00020',
            allCounts.range_1001_plus,
            filteredCounts.range_1001_plus,
            filteredRowsCount,
            filters,
            filters.daysRange
          ) +
          buildBadge(
            'No activity',
            'NO_ACTIVITY',
            '#f3f4f6',
            '#d9dde3',
            '#6b7280',
            allCounts.no_activity,
            filteredCounts.no_activity,
            filteredRowsCount,
            filters,
            filters.daysRange
          ) +
        '</div>' +
      '</div>';
  }

  function buildResultsTable(allRows, rows, allRowsCount, filteredRowsCount, downloadUrl, filters) {
    const preview = rows.slice(0, MAX_PREVIEW_ROWS);
    const allCounts = getActivityCounts(allRows);
    const filteredCounts = getActivityCounts(rows);
    let html = '';

    html += '<div style="margin-top:12px;">';
    html += buildSummaryHtml(
      allRowsCount,
      filteredRowsCount,
      downloadUrl,
      allCounts,
      filteredCounts,
      filters
    );
    html += '<div style="font-size:20px; font-weight:700; color:#7a2020; margin:8px 0 12px 0;">Latest Results</div>';

    if (!preview.length) {
      html += '<div style="padding:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px; color:#666;">No results found.</div>';
      html += '</div>';
      return html;
    }

    html += '<div style="overflow:auto; border:1px solid #d1d5db; border-radius:6px;">';
    html += '<table style="border-collapse:collapse; width:100%; min-width:1500px; font-size:13px;">';

    html += '<thead>';
    html += '<tr style="background:#f3f4f6;">';
    for (let i = 0; i < FIELD_CONFIG.length; i += 1) {
      html += buildHeaderCell(FIELD_CONFIG[i], filters);
    }
    html += '</tr>';
    html += '</thead>';

    html += '<tbody>';
    for (let line = 0; line < preview.length; line += 1) {
      const row = preview[line];
      html += '<tr' + (line % 2 === 0 ? ' style="background:#fff;"' : ' style="background:#fafafa;"') + '>';

      for (let i = 0; i < FIELD_CONFIG.length; i += 1) {
        const field = FIELD_CONFIG[i];
        const value = row[field.key];

        if (field.key === 'days_since_last_activity') {
          html += '<td style="padding:8px; border-bottom:1px solid #eee; white-space:nowrap;">' +
            getTrafficLightHtml(value) +
          '</td>';
        } else if (DATE_FIELDS[field.key]) {
          html += '<td style="padding:8px; border-bottom:1px solid #eee; white-space:nowrap;">' +
            formatDateBold2026(value) +
          '</td>';
        } else {
          html += '<td style="padding:8px; border-bottom:1px solid #eee; white-space:nowrap;">' +
            escapeHtml(value) +
          '</td>';
        }
      }

      html += '</tr>';
    }
    html += '</tbody>';
    html += '</table>';
    html += '</div>';

    if (rows.length > MAX_PREVIEW_ROWS) {
      html += '<div style="margin-top:8px; font-size:12px; color:#666;">' +
        'Showing first ' + escapeHtml(MAX_PREVIEW_ROWS) + ' rows of ' + escapeHtml(rows.length) + '. Use Download CSV for full results.' +
      '</div>';
    }

    html += '</div>';
    return html;
  }

  function buildHeaderCell(field, filters) {
    const currentSortBy = normalizeSortBy(filters.sortBy);
    const currentSortDir = normalizeSortDir(filters.sortDir);
    let content = escapeHtml(field.label);

    if (SORTABLE_DATE_FIELDS[field.key]) {
      const sortUrl = buildSortUrl(filters, field.key);
      let sortIcon = '&#8597;';

      if (currentSortBy === field.key) {
        sortIcon = currentSortDir === 'asc' ? '&#9650;' : '&#9660;';
      }

      content = '<a href="' + escapeHtml(sortUrl) + '" style="' +
        'color:#374151;' +
        'text-decoration:none;' +
        'white-space:nowrap;' +
        'display:inline-block;' +
      '">' +
        escapeHtml(field.label) +
        '<span style="font-size:10px; color:#6b7280; margin-left:4px;">' + sortIcon + '</span>' +
      '</a>';
    }

    return '<th style="' +
      'position:sticky; top:0;' +
      'background:#e5e7eb;' +
      'padding:10px 8px;' +
      'text-align:left;' +
      'border-bottom:1px solid #d1d5db;' +
      'color:#555;' +
      'font-weight:700;' +
    '">' + content + '</th>';
  }

  function addResultsHtml(form, allRows, rows, allRowsCount, filteredRowsCount, downloadUrl, filters) {
    const resultsField = form.addField({
      id: 'custpage_results_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: ' '
    });

    resultsField.updateBreakType({
      breakType: serverWidget.FieldBreakType.STARTROW
    });

    resultsField.updateLayoutType({
      layoutType: serverWidget.FieldLayoutType.OUTSIDEBELOW
    });

    resultsField.defaultValue = buildResultsTable(
      allRows,
      rows,
      allRowsCount,
      filteredRowsCount,
      downloadUrl,
      filters
    );
  }

  function writePage(context, allRows, filteredRows, filters) {
    const form = serverWidget.createForm({
      title: 'Vendors Activity Report'
    });

    const downloadUrl = buildDownloadUrl(filters);

    addFilterFields(form, filters);
    addResultsHtml(
      form,
      allRows,
      filteredRows,
      allRows.length,
      filteredRows.length,
      downloadUrl,
      filters
    );

    context.response.writePage(form);
  }

  function writeErrorPage(context, e) {
    const form = serverWidget.createForm({
      title: 'Active Vendors Activity Report'
    });

    const html = form.addField({
      id: 'custpage_error',
      type: serverWidget.FieldType.INLINEHTML,
      label: ' '
    });

    html.defaultValue =
      '<div style="color:#b00020; font-weight:600; padding:8px 0;">' +
        'Error generating report:<br/>' +
        escapeHtml(e && e.name ? e.name : 'ERROR') +
        ' - ' +
        escapeHtml(e && e.message ? e.message : e) +
      '</div>';

    context.response.writePage(form);
  }

  function getFilters(request) {
    const sortBy = normalizeSortBy(request.parameters.custpage_sort_by || request.parameters.sort_by || '');

    return {
      vendor: safeText(request.parameters.custpage_filter_vendor || request.parameters.vendor || '').trim(),
      daysRange: safeText(request.parameters.custpage_filter_days_range || request.parameters.daysrange || ''),
      threshold: safeText(request.parameters.custpage_filter_threshold || request.parameters.threshold || ''),
      sortBy: sortBy,
      sortDir: sortBy ? normalizeSortDir(request.parameters.custpage_sort_dir || request.parameters.sort_dir || '') : ''
    };
  }

  function onRequest(context) {
    try {
      const action = safeText(context.request.parameters.action || 'view');
      const filters = getFilters(context.request);

      const allRows = runReport();
      const filteredRows = applyFilters(allRows, filters);
      applySort(filteredRows, filters);

      if (action === 'download') {
        writeCsv(context, filteredRows);
        return;
      }

      writePage(context, allRows, filteredRows, filters);
    } catch (e) {
      log.error({
        title: 'Vendor activity report failed',
        details: e
      });
      writeErrorPage(context, e);
    }
  }

  return { onRequest: onRequest };
});
