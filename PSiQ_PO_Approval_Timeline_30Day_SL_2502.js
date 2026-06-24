/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * PO Approval Timeline - Last 30 Days
 * Version: 1.5.20
 * Developer: Rama Ambati
 *
 * Shows every purchase order in the selected date window with the persisted
 * approval stages created by Po_approval_timeline.js.
 */



define([
  'N/ui/serverWidget',
  'N/search',
  'N/format',
  'N/url',
  'N/runtime',
  'N/record',
  'N/file',
  'N/log'
], (serverWidget, search, format, url, runtime, record, file, log) => {
  // Central runtime settings for the Suitelet. Keeping the field lists here makes
  // it easier to add or remove NetSuite custom fields without touching query code.
  const CONFIG = {
    title: 'PO Approval Timeline - Last 30 Days',
    version: '1.5.20',
    developerName: 'Rama Ambati',
    defaultDaysBack: 30,
    pageSize: 100,
    childRecordType: 'customrecord_po_approval_sta',
    systemNoteBatchSize: 100,
    enableWorkflowRecordFallback: false,
    enableSystemNoteStageSupplement: false,
    workdayStartHour: 8,
    workdayEndHour: 17,
    requestorFieldIds: [
      'custbody_nsacs_psiq_requestor',
      'custbody_psiq_requestor',
      'custbody_requestor',
      'custbody_po_requestor',
      'custbody_employee_requestor',
      'requestor',
      'createdby',
      'employee'
    ],
    orderCreatorFieldIds: [
      'custbody5'
    ],
    createdDateFieldIds: [
      'createddate'
    ],
    approvalDateFieldIds: [
      'approvaldate',
      'dateapproved',
      'approveddate'
    ],
    nextApproverFieldIds: [
      'nextapprover',
      'custbodynextapprover',
      'custbody_nextapprover',
      'custbody_next_approver'
    ],
    nextApproverRoleFieldIds: [
      'nextapproverrole',
      'custbodynextapproverrole',
      'custbody_nextapproverrole',
      'custbody_next_approver_role'
    ]
  };

  // Field IDs on the persisted child approval-stage record populated by the
  // capture script. These values are the primary source for stage timing.
  const F = {
    PARENT: 'custrecord_pas_parent_po',
    SEQ: 'custrecord_pas_seq',
    APPROVER: 'custrecord_pas_approver',
    ROLE: 'custrecord_pas_role',
    START: 'custrecord_pas_start',
    END: 'custrecord_pas_end',
    CAL_MINS: 'custrecord_pas_calendar_mins',
    BUS_MINS: 'custrecord_pas_business_mins',
    STATUS: 'custrecord_pas_status',
    END_REASON: 'custrecord_pas_end_reason',
    IS_CURRENT: 'custrecord_pas_is_current'
  };

  // Optional analytics fields can be deployed later than the base child record,
  // so every read is guarded by an availability check before a search is built.
  const ANALYTICS_FIELDS = {
    APPROVER_TEXT: 'custrecord_pas_approver_text',
    TRANSITION_TYPE: 'custrecord_pas_transition_type',
    WAIT_MINS: 'custrecord_pas_nonbusiness_mins',
    SLA_BREACHED: 'custrecord_pas_sla_breached',
    IS_BOTTLENECK: 'custrecord_pas_is_bottleneck'
  };

  // Per-request caches avoid re-probing field/record availability every time the
  // same optional column is needed by another search.
  const STATE = {
    optionalFieldCache: {},
    transactionColumnCache: {},
    childRecordTypeAvailable: null
  };

  function onRequest(context) {
    const request = context.request;
    const response = context.response;

    try {
      // Normalize all incoming NetSuite request parameters before any data load
      // so page rendering, CSV, and Excel export all share exactly the same rules.
      const filters = normalizeFilters(request.parameters || {});
      const data = getReportData(filters);
      const exportFormat = clean(request.parameters.export).toUpperCase();

      // Export requests use the same report data as the dashboard. Only the final
      // serializer changes, which keeps on-screen and downloaded values aligned.
      if (exportFormat === 'XLS' || exportFormat === 'EXCEL' || exportFormat === 'XLSX') {
        writeExcel(response, data);
        return;
      }

      if (exportFormat === 'CSV') {
        writeCsv(response, data);
        return;
      }

      const form = buildForm(filters, data);
      response.writePage(form);
    } catch (e) {
      // A Suitelet error should still render a friendly NetSuite page rather than
      // leaving the user with a raw script exception.
      log.error({
        title: 'PO approval 30 day Suitelet failed',
        details: describeError(e)
      });
      writeErrorPage(response, e);
    }
  }

  function buildForm(filters, data) {
    // NetSuite form fields host the filters; the main dashboard is rendered as
    // inline HTML so the report can use a richer table layout than sublists allow.
    const form = serverWidget.createForm({ title: CONFIG.title });

    addFilterFields(form, filters);
    addExportLink(form, filters);

    const html = form.addField({
      id: 'custpage_dashboard_html',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Approval Timeline'
    });
    html.defaultValue = buildDashboardHtml(data);

    form.addSubmitButton({ label: 'Refresh Timeline' });
    return form;
  }

  function addFilterFields(form, filters) {
    // These field IDs are also read by normalizeFilters, so keep the IDs stable
    // when making UI label-only changes.
    form.addFieldGroup({
      id: 'custpage_filters',
      label: 'Filters'
    });

    const fromField = form.addField({
      id: 'custpage_datefrom',
      type: serverWidget.FieldType.DATE,
      label: 'PO Date From',
      container: 'custpage_filters'
    });
    fromField.defaultValue = filters.dateFromText;

    const toField = form.addField({
      id: 'custpage_dateto',
      type: serverWidget.FieldType.DATE,
      label: 'PO Date To',
      container: 'custpage_filters'
    });
    toField.defaultValue = filters.dateToText;
    toField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTCOL });

    const searchField = form.addField({
      id: 'custpage_search',
      type: serverWidget.FieldType.TEXT,
      label: 'Search PO, Vendor, Requestor, Approver',
      container: 'custpage_filters'
    });
    searchField.defaultValue = filters.searchText;

    const timelineOnlyField = form.addField({
      id: 'custpage_timelineonly',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Only POs With Captured Timeline',
      container: 'custpage_filters'
    });
    timelineOnlyField.defaultValue = filters.timelineOnly ? 'T' : 'F';
    timelineOnlyField.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTCOL });

    const collapseStageLinesField = form.addField({
      id: 'custpage_collapsestagelines',
      type: serverWidget.FieldType.CHECKBOX,
      label: 'Hide Stage Lines 2+',
      container: 'custpage_filters'
    });
    collapseStageLinesField.defaultValue = filters.collapseStageLines ? 'T' : 'F';
  }

  function addExportLink(form, filters) {
    // Export links round-trip the current filters and page index. This prevents
    // the downloaded workbook from silently reverting to the default 30-day view.
    const fld = form.addField({
      id: 'custpage_export_link',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Export',
      container: 'custpage_filters'
    });

    const currentScript = runtime.getCurrentScript();
    const exportUrl = url.resolveScript({
      scriptId: currentScript.id,
      deploymentId: currentScript.deploymentId,
      params: {
        export: 'XLS',
        custpage_datefrom: filters.dateFromText,
        custpage_dateto: filters.dateToText,
        custpage_search: filters.searchText || '',
        custpage_timelineonly: filters.timelineOnly ? 'T' : 'F',
        custpage_collapsestagelines: filters.collapseStageLines ? 'T' : 'F',
        custpage_page: String(filters.pageIndex || 0)
      }
    });

    fld.defaultValue =
      '<div style="margin:6px 0 0;">' +
      '<a href="' + escAttr(exportUrl) + '" style="display:inline-block;padding:7px 12px;border-radius:4px;background:#1f6f5b;color:#fff;text-decoration:none;font-weight:700;">Export Excel Page</a>' +
      '</div>';
  }

  function getReportData(filters) {
    // Data flow:
    // 1. Load the current page of purchase orders.
    // 2. Attach captured approval stages or fallback stages.
    // 3. Fill milestone dates from workflow history/system notes.
    // 4. Normalize each PO into a render/export-friendly summary row.
    const poPage = getPurchaseOrders(filters);
    const poRows = poPage.rows;
    const stagesByPo = loadStagesForPurchaseOrders(poRows, filters);
    const workflowSubmitByPo = loadWorkflowSubmitTimingsForPurchaseOrders(poRows, stagesByPo);
    const procurementApprovalByPo = loadProcurementApprovalDatesForPurchaseOrders(poRows);
    const poOrderByPo = loadPoOrderDatesForPurchaseOrders(poRows);
    const requestorStartByPo = loadRequestorStartTimesForPurchaseOrders(
      getRequestorStartFallbackRows(poRows, stagesByPo, workflowSubmitByPo)
    );

    let rows = poRows.map(po => {
      // Captured stage records are preferred. If none exist, use a conservative
      // current-approver fallback so pending POs still show useful context.
      const stages = stagesByPo[po.internalId] || buildCurrentApproverFallbackStages(po);
      return buildPurchaseOrderSummary(
        po,
        stages,
        buildRequestorTiming(po, stages, workflowSubmitByPo[po.internalId], requestorStartByPo[po.internalId]),
        procurementApprovalByPo[po.internalId],
        poOrderByPo[po.internalId]
      );
    });

    if (filters.timelineOnly) {
      // The checkbox is applied after fallback construction so "timeline" means
      // any visible timing context, not only persisted child-record stages.
      rows = rows.filter(row => row.stages.length > 0);
    }

    if (filters.searchText) {
      // Broad search is applied after enrichment because requestor/approver names
      // may come from optional fields, child records, or System Notes fallbacks.
      rows = filterRowsBySearch(rows, filters.searchText);
    }

    const summary = buildSummary(rows);

    return {
      filters: filters,
      rows: rows,
      summary: summary,
      pagination: poPage.pagination
    };
  }

  function getPurchaseOrders(filters) {
    const rows = [];
    // Different accounts/sandboxes may use different custom field IDs for the
    // same business concept. Probe first, then query only columns NetSuite accepts.
    const createdDateColumnIds = getSearchableTransactionColumnIds(CONFIG.createdDateFieldIds);
    const approvalDateColumnIds = getSearchableTransactionColumnIds(CONFIG.approvalDateFieldIds);
    const requestorColumnIds = getSearchableTransactionColumnIds(CONFIG.requestorFieldIds);
    const orderCreatorColumnIds = getSearchableTransactionColumnIds(CONFIG.orderCreatorFieldIds);
    const nextApproverColumnIds = getSearchableTransactionColumnIds(CONFIG.nextApproverFieldIds);
    const nextApproverRoleColumnIds = getSearchableTransactionColumnIds(CONFIG.nextApproverRoleFieldIds);
    const optionalColumnIds = createdDateColumnIds.concat(approvalDateColumnIds, requestorColumnIds, orderCreatorColumnIds, nextApproverColumnIds, nextApproverRoleColumnIds);
    const txFilters = [
      ['type', 'anyof', 'PurchOrd'],
      'AND',
      ['mainline', 'is', 'T'],
      'AND',
      ['trandate', 'within', filters.dateFromText, filters.dateToText]
    ];
    const tranIdSearchText = clean(filters.searchText).replace(/\s+/g, '');

    if (shouldApplyTranIdSearch(tranIdSearchText)) {
      // Use tranid filtering only for PO-like search terms. General text search
      // happens after enrichment so vendor/requestor/approver matches still work.
      txFilters.push('AND', ['tranid', 'contains', tranIdSearchText]);
    }

    const txSearch = search.create({
      type: search.Type.TRANSACTION,
      filters: txFilters,
      columns: [
        search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'tranid' }),
        search.createColumn({ name: 'entity' }),
        search.createColumn({ name: 'datecreated' }),
        search.createColumn({ name: 'approvalstatus' }),
        search.createColumn({ name: 'statusref' }),
        search.createColumn({ name: 'amount' })
      ].concat(optionalColumnIds.map(fieldId => search.createColumn({ name: fieldId })))
    });

    const paged = txSearch.runPaged({ pageSize: CONFIG.pageSize });
    const totalCount = Number(paged.count || 0);
    const pageCount = totalCount ? Math.ceil(totalCount / CONFIG.pageSize) : 0;
    const requestedPageIndex = Number(filters.pageIndex || 0);
    const pageIndex = pageCount
      ? Math.min(Math.max(isNaN(requestedPageIndex) ? 0 : requestedPageIndex, 0), pageCount - 1)
      : 0;

    if (pageCount) {
      // Only fetch the requested page. The summary metrics intentionally describe
      // the current page so the Suitelet stays fast on large date windows.
      const page = paged.fetch({ index: pageIndex });
      page.data.forEach(result => {
        const internalId = result.getValue('internalid') || '';
        if (!internalId) return;

        const dateCreatedText = clean(result.getValue('datecreated'));
        const alternateCreatedDateText = readFirstResultColumnText(result, createdDateColumnIds);
        const approvalDateText = readFirstResultColumnText(result, approvalDateColumnIds);

        rows.push({
          internalId: String(internalId),
          tranId: result.getValue('tranid') || '',
          vendor: result.getText('entity') || result.getValue('entity') || '',
          tranDate: result.getValue('trandate') || '',
          // Prefer the earliest available created timestamp because some custom
          // fields capture the PR/PO creation event earlier than datecreated.
          createdDate: chooseEarliestDateTimeText([alternateCreatedDateText, dateCreatedText]),
          approvalDate: approvalDateText,
          approvalStatus: result.getText('approvalstatus') || result.getValue('approvalstatus') || '',
          transactionStatus: result.getText('statusref') || result.getValue('statusref') || '',
          amount: toNumber(result.getValue('amount')),
          requestor: readFirstResultColumnText(result, requestorColumnIds),
          orderCreator: readFirstResultColumnText(result, orderCreatorColumnIds),
          nextApprover: normalizeApproverDisplay(readFirstResultColumnText(result, nextApproverColumnIds)),
          nextApproverRole: readFirstResultColumnText(result, nextApproverRoleColumnIds),
          url: resolvePurchaseOrderUrl(internalId)
        });
      });
    }

    return {
      rows: rows,
      pagination: {
        pageIndex: pageIndex,
        pageNumber: pageCount ? pageIndex + 1 : 0,
        pageSize: CONFIG.pageSize,
        pageCount: pageCount,
        totalCount: totalCount,
        start: totalCount ? pageIndex * CONFIG.pageSize + 1 : 0,
        end: totalCount ? Math.min((pageIndex + 1) * CONFIG.pageSize, totalCount) : 0
      }
    };
  }

  function loadStagesForPurchaseOrders(poRows, filters) {
    const uniqueIds = uniqueTruthy((poRows || []).map(row => row && row.internalId ? row.internalId : row));
    if (!uniqueIds.length) return {};

    if (!isChildRecordTypeAvailable()) {
      // If the child record has not been deployed to this account, fall back to
      // System Notes so the report can still be used during rollout.
      log.audit({
        title: 'PO approval timeline child record unavailable',
        details: CONFIG.childRecordType + ' is not available. Loading narrowed approval System Notes timeline.'
      });
      return loadSystemNoteStagesForPurchaseOrders(uniqueIds);
    }

    try {
      const persistedStages = loadPersistedStagesForPurchaseOrders(uniqueIds);
      // System Notes supplementation is disabled by default because persisted
      // stages are more reliable; the flag allows controlled debugging/rollout.
      if (!CONFIG.enableSystemNoteStageSupplement) return persistedStages;
      return supplementShortTimelinesWithSystemNotes(persistedStages, uniqueIds);
    } catch (e) {
      log.error({
        title: 'PO approval timeline child record search failed',
        details: describeError(e)
      });
      return loadSystemNoteStagesForPurchaseOrders(uniqueIds);
    }
  }

  function loadPersistedStagesForPurchaseOrders(poIds) {
    const byPo = {};

    const opt = getLoadableOptionalFields();
    const chunks = chunkArray(poIds, 1000);

    chunks.forEach(idChunk => {
      // NetSuite "anyof" filters are safest in chunks. Keep each search under the
      // practical 1000-ID limit to avoid governance and search parser failures.
      const columns = [
        search.createColumn({ name: F.PARENT, sort: search.Sort.ASC }),
        search.createColumn({ name: F.SEQ, sort: search.Sort.ASC }),
        search.createColumn({ name: F.APPROVER }),
        search.createColumn({ name: F.ROLE }),
        search.createColumn({ name: F.START }),
        search.createColumn({ name: F.END }),
        search.createColumn({ name: F.CAL_MINS }),
        search.createColumn({ name: F.BUS_MINS }),
        search.createColumn({ name: F.STATUS }),
        search.createColumn({ name: F.END_REASON }),
        search.createColumn({ name: F.IS_CURRENT }),
        search.createColumn({ name: 'name' })
      ];

      if (opt.approverText) columns.push(search.createColumn({ name: ANALYTICS_FIELDS.APPROVER_TEXT }));
      if (opt.transitionType) columns.push(search.createColumn({ name: ANALYTICS_FIELDS.TRANSITION_TYPE }));
      if (opt.waitMins) columns.push(search.createColumn({ name: ANALYTICS_FIELDS.WAIT_MINS }));
      if (opt.slaBreached) columns.push(search.createColumn({ name: ANALYTICS_FIELDS.SLA_BREACHED }));
      if (opt.isBottleneck) columns.push(search.createColumn({ name: ANALYTICS_FIELDS.IS_BOTTLENECK }));

      const stageSearch = search.create({
        type: CONFIG.childRecordType,
        filters: [[F.PARENT, 'anyof', idChunk]],
        columns: columns
      });

      runPaged(stageSearch, result => {
        const poId = String(result.getValue(F.PARENT) || '');
        if (!poId) return;

        const nameValue = result.getValue('name') || '';
        // approverText is a denormalized display field when available. Otherwise
        // use the list text or parse the record name as a last resort.
        const stage = {
          seq: Number(result.getValue(F.SEQ) || 0),
          approverText: opt.approverText
            ? clean(result.getValue(ANALYTICS_FIELDS.APPROVER_TEXT)) || result.getText(F.APPROVER) || extractApproverFromName(nameValue) || 'Unknown'
            : result.getText(F.APPROVER) || extractApproverFromName(nameValue) || 'Unknown',
          role: result.getValue(F.ROLE) || 'Role not captured',
          start: parseNsDateTime(result.getValue(F.START)),
          startText: result.getValue(F.START) || '',
          end: parseNsDateTime(result.getValue(F.END)),
          endText: result.getValue(F.END) || '',
          calendarMins: Number(result.getValue(F.CAL_MINS) || 0),
          businessMins: Number(result.getValue(F.BUS_MINS) || 0),
          waitMins: opt.waitMins
            ? Number(result.getValue(ANALYTICS_FIELDS.WAIT_MINS) || 0)
            : Math.max(0, Number(result.getValue(F.CAL_MINS) || 0) - Number(result.getValue(F.BUS_MINS) || 0)),
          status: result.getValue(F.STATUS) || '',
          endReason: result.getValue(F.END_REASON) || '',
          isCurrent: toBool(result.getValue(F.IS_CURRENT)),
          transitionType: opt.transitionType ? result.getValue(ANALYTICS_FIELDS.TRANSITION_TYPE) || '' : '',
          slaBreached: opt.slaBreached ? toBool(result.getValue(ANALYTICS_FIELDS.SLA_BREACHED)) : false,
          isBottleneck: opt.isBottleneck ? toBool(result.getValue(ANALYTICS_FIELDS.IS_BOTTLENECK)) : false
        };

        if (!byPo[poId]) byPo[poId] = [];
        byPo[poId].push(stage);
      });
    });

    Object.keys(byPo).forEach(poId => {
      byPo[poId].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));

      let maxBusiness = 0;
      byPo[poId].forEach(stage => {
        maxBusiness = Math.max(maxBusiness, Number(stage.businessMins || 0));
      });

      byPo[poId].forEach((stage, idx) => {
        // displaySeq is recalculated after sorting so gaps or duplicate stored
        // sequence numbers do not confuse the UI.
        stage.displaySeq = idx + 1;
        if (!stage.isBottleneck) {
          // Older child records may not have stored bottleneck flags. Recreate the
          // flag from the highest business-minute stage when needed.
          stage.isBottleneck = maxBusiness > 0 && Number(stage.businessMins || 0) === maxBusiness;
        }
      });
    });

    return byPo;
  }

  function supplementShortTimelinesWithSystemNotes(persistedStages, poIds) {
    const byPo = persistedStages || {};
    const shortTimelineIds = uniqueTruthy(poIds).filter(poId => !byPo[poId] || byPo[poId].length < 2);

    if (!shortTimelineIds.length) return byPo;

    let noteStages = {};
    try {
      noteStages = loadSystemNoteStagesForPurchaseOrders(shortTimelineIds);
    } catch (e) {
      log.error({
        title: 'PO approval System Notes supplement failed',
        details: describeError(e)
      });
      return byPo;
    }

    shortTimelineIds.forEach(poId => {
      const existing = byPo[poId] || [];
      const fromNotes = noteStages[poId] || [];

      if (!fromNotes.length) return;
      // Replace only when System Notes adds more stage detail or a different
      // approver, keeping captured child records as the default truth source.
      if (fromNotes.length > existing.length || hasNewApproverCoverage(existing, fromNotes)) {
        byPo[poId] = fromNotes;
      }
    });

    return byPo;
  }

  function hasNewApproverCoverage(existingStages, candidateStages) {
    // Compare normalized display names so "John Smith" and whitespace variants do
    // not produce duplicate coverage decisions.
    const seen = {};

    (existingStages || []).forEach(stage => {
      const key = normalizeApproverKey(stage.approverText);
      if (key) seen[key] = true;
    });

    return (candidateStages || []).some(stage => {
      const key = normalizeApproverKey(stage.approverText);
      return key && !seen[key];
    });
  }

  function isChildRecordTypeAvailable() {
    if (STATE.childRecordTypeAvailable !== null) {
      return STATE.childRecordTypeAvailable;
    }

    let available = false;
    try {
      // Use a no-result search as a lightweight schema probe. If the record type
      // or field permissions are missing, NetSuite throws before returning data.
      search.create({
        type: CONFIG.childRecordType,
        filters: [['internalid', 'anyof', '@NONE@']],
        columns: [search.createColumn({ name: 'internalid' })]
      }).run().getRange({ start: 0, end: 1 });
      available = true;
    } catch (e) {
      available = false;
    }

    STATE.childRecordTypeAvailable = available;
    return available;
  }

  function loadWorkflowSubmitTimingsForPurchaseOrders(poRows, stagesByPo) {
    const candidateRows = [];

    (poRows || []).forEach(po => {
      const poId = po && po.internalId ? String(po.internalId) : '';
      if (!poId || !po.orderCreator) return;

      const firstApprovalStage = getFirstApprovalStage(stagesByPo && stagesByPo[poId]);
      // Only hunt for Submit for Approval timing when the PO created date appears
      // to overlap the first approver stage. Otherwise the header date is enough.
      if (!shouldLoadWorkflowSubmitTiming(po, firstApprovalStage)) return;

      candidateRows.push({
        po: po,
        poId: poId,
        firstApprovalStage: firstApprovalStage
      });
    });

    const byPo = loadWorkflowSubmitTimingsFromTransactionSearch(candidateRows);

    // Record loading is slower and can hit workflow locks, so it remains an
    // opt-in fallback after the safer workflow-history joined search.
    if (!CONFIG.enableWorkflowRecordFallback) return byPo;

    candidateRows.forEach(candidate => {
      if (byPo[candidate.poId]) return;

      const timing = readWorkflowSubmitTimingFromRecord(candidate.poId, candidate.firstApprovalStage);
      if (timing) byPo[candidate.poId] = timing;
    });

    return byPo;
  }

  function getRequestorStartFallbackRows(poRows, stagesByPo, workflowSubmitByPo) {
    // When workflow submit timing is unavailable, System Notes can still provide
    // the first PO touch before the first approval stage.
    return (poRows || []).filter(po => {
      const poId = po && po.internalId ? String(po.internalId) : '';
      if (!poId || workflowSubmitByPo[poId]) return false;

      const firstApprovalStage = getFirstApprovalStage(stagesByPo && stagesByPo[poId]);
      if (!firstApprovalStage || !firstApprovalStage.start) return false;

      const createdDate = parseNsDateTime(po && po.createdDate);
      return !createdDate || diffMinutes(createdDate, firstApprovalStage.start) === 0;
    });
  }

  function loadWorkflowSubmitTimingsFromTransactionSearch(candidates) {
    const byPo = {};
    const poIds = uniqueTruthy((candidates || []).map(candidate => candidate.poId));
    if (!poIds.length) return byPo;

    const firstApprovalStartByPo = {};
    (candidates || []).forEach(candidate => {
      const firstApprovalStage = candidate.firstApprovalStage;
      if (candidate.poId && firstApprovalStage && firstApprovalStage.start) {
        firstApprovalStartByPo[candidate.poId] = firstApprovalStage.start;
      }
    });

    const searchSpecs = getWorkflowHistorySearchSpecs();

    for (let i = 0; i < searchSpecs.length; i++) {
      const spec = searchSpecs[i];
      const remainingPoIds = poIds.filter(poId => !byPo[poId]);
      if (!remainingPoIds.length) break;

      // NetSuite workflow-history join/field casing can vary. Try known variants
      // until one search proves readable for this account.
      if (tryWorkflowHistorySearchSpec(spec, remainingPoIds, firstApprovalStartByPo, byPo)) {
        break;
      }
    }

    return byPo;
  }

  function loadProcurementApprovalDatesForPurchaseOrders(poRows) {
    const byPo = {};
    const poIds = uniqueTruthy((poRows || []).map(row => row && row.internalId ? row.internalId : row));
    if (!poIds.length) return byPo;

    const searchSpecs = getWorkflowHistorySearchSpecs();

    for (let i = 0; i < searchSpecs.length; i++) {
      const spec = searchSpecs[i];
      const remainingPoIds = poIds.filter(poId => !byPo[poId]);
      if (!remainingPoIds.length) break;

      let searchSucceeded = true;
      chunkArray(remainingPoIds, 1000).forEach(idChunk => {
        // Controller/procurement exit marks the handoff from procurement approval
        // to PO ordering for the dashboard milestone column.
        if (!tryWorkflowHistoryControllerExitDateSearchSpec(spec, idChunk, byPo)) {
          searchSucceeded = false;
        }
      });

      if (searchSucceeded) break;
    }

    // Optional fallback uses direct record load only for POs that appear approved
    // or terminal, reducing the chance of loading active locked workflow records.
    if (!CONFIG.enableWorkflowRecordFallback) return byPo;

    (poRows || []).forEach(po => {
      const poId = po && po.internalId ? String(po.internalId) : '';
      if (!poId || byPo[poId] || !shouldLoadWorkflowMilestoneDateFallback(po)) return;

      const approvalDate = readControllerExitDateFromRecord(poId);
      if (approvalDate) byPo[poId] = approvalDate;
    });

    return byPo;
  }

  function loadPoOrderDatesForPurchaseOrders(poRows) {
    const byPo = {};
    const poIds = uniqueTruthy((poRows || []).map(row => row && row.internalId ? row.internalId : row));
    if (!poIds.length) return byPo;

    const searchSpecs = getWorkflowHistoryDateSearchSpecs();

    for (let i = 0; i < searchSpecs.length; i++) {
      const spec = searchSpecs[i];
      const remainingPoIds = poIds.filter(poId => !byPo[poId]);
      if (!remainingPoIds.length) break;

      let searchSucceeded = true;
      chunkArray(remainingPoIds, 1000).forEach(idChunk => {
        // PO order date is treated as the workflow "Approved" state entered date.
        if (!tryWorkflowHistoryPoOrderDateSearchSpec(spec, idChunk, byPo)) {
          searchSucceeded = false;
        }
      });

      if (searchSucceeded) break;
    }

    // Direct record fallback stays behind the config flag for the same governance
    // and workflow-lock reasons as the procurement approval lookup.
    if (!CONFIG.enableWorkflowRecordFallback) return byPo;

    (poRows || []).forEach(po => {
      const poId = po && po.internalId ? String(po.internalId) : '';
      if (!poId || byPo[poId] || !shouldLoadWorkflowMilestoneDateFallback(po)) return;

      const approvalDate = readPoOrderDateFromRecord(poId);
      if (approvalDate) byPo[poId] = approvalDate;
    });

    return byPo;
  }

  function getWorkflowHistoryDateSearchSpecs() {
    // Build every known casing/field-name combination for workflow history. This
    // avoids hard-coding one NetSuite account's internal join naming.
    const joins = ['workflowHistory', 'workflowhistory'];
    const stateFields = ['state', 'statenameinfo'];
    const enteredFields = ['dateenteredstate', 'dateEnteredState', 'dateentered'];
    const specs = [];

    joins.forEach(joinId => {
      stateFields.forEach(stateField => {
        enteredFields.forEach(enteredField => {
          specs.push({
            joinId: joinId,
            stateField: stateField,
            enteredField: enteredField
          });
        });
      });
    });

    return specs;
  }

  function tryWorkflowHistoryPoOrderDateSearchSpec(spec, poIds, outByPo) {
    try {
      let sawReadableWorkflowState = false;
      const internalIdColumn = search.createColumn({ name: 'internalid', sort: search.Sort.ASC });
      const stateColumn = search.createColumn({ name: spec.stateField, join: spec.joinId });
      const enteredColumn = search.createColumn({ name: spec.enteredField, join: spec.joinId });
      const wfSearch = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'PurchOrd'],
          'AND',
          ['mainline', 'is', 'T'],
          'AND',
          ['internalid', 'anyof', poIds]
        ],
        columns: [internalIdColumn, stateColumn, enteredColumn]
      });

      runPaged(wfSearch, result => {
        const poId = clean(result.getValue(internalIdColumn));
        if (!poId) return;

        const stateName = result.getText(stateColumn) || result.getValue(stateColumn);
        if (hasReadableWorkflowStateName(stateName)) sawReadableWorkflowState = true;
        if (!isWorkflowApprovedState(stateName)) return;

        const enteredRaw = result.getValue(enteredColumn);
        const entered = parseNsDateTime(enteredRaw);
        if (!entered) return;

        // Keep the latest matching approved-state timestamp for each PO.
        recordWorkflowDate(outByPo, poId, entered, enteredRaw, 'Workflow History approved state');
      });
      return sawReadableWorkflowState;
    } catch (e) {
      return false;
    }
  }

  function tryWorkflowHistoryControllerExitDateSearchSpec(spec, poIds, outByPo) {
    try {
      let sawReadableWorkflowState = false;
      const internalIdColumn = search.createColumn({ name: 'internalid', sort: search.Sort.ASC });
      const stateColumn = search.createColumn({ name: spec.stateField, join: spec.joinId });
      const enteredColumn = search.createColumn({ name: spec.enteredField, join: spec.joinId });
      const exitedColumn = search.createColumn({ name: spec.exitedField, join: spec.joinId });
      const wfSearch = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'PurchOrd'],
          'AND',
          ['mainline', 'is', 'T'],
          'AND',
          ['internalid', 'anyof', poIds]
        ],
        columns: [internalIdColumn, stateColumn, enteredColumn, exitedColumn]
      });

      runPaged(wfSearch, result => {
        const poId = clean(result.getValue(internalIdColumn));
        if (!poId) return;

        const stateName = result.getText(stateColumn) || result.getValue(stateColumn);
        if (hasReadableWorkflowStateName(stateName)) sawReadableWorkflowState = true;
        if (!isWorkflowControllerState(stateName)) return;

        const enteredRaw = result.getValue(enteredColumn);
        const exitedRaw = result.getValue(exitedColumn);
        const entered = parseNsDateTime(enteredRaw);
        const exited = parseNsDateTime(exitedRaw);

        if (!exited) return;
        // Ignore malformed workflow rows where exit predates entry.
        if (entered && exited.getTime() < entered.getTime()) return;

        recordProcurementApprovalWorkflowDate(outByPo, poId, stateName, exited, exitedRaw);
      });
      return sawReadableWorkflowState;
    } catch (e) {
      return false;
    }
  }

  function shouldLoadWorkflowMilestoneDateFallback(po) {
    if (!po) return false;
    // Direct record fallback is most useful after approval; pending POs may still
    // be locked by workflow and generally do not have these milestone dates yet.
    return !!po.approvalDate ||
      isApprovedStatus(po.approvalStatus) ||
      isTerminalTransactionStatus(po.transactionStatus);
  }

  function readPoOrderDateFromRecord(poId) {
    return readWorkflowMilestoneDateFromRecord(
      poId,
      isWorkflowApprovedState,
      'entered',
      'Workflow History approved state'
    );
  }

  function readControllerExitDateFromRecord(poId) {
    return readWorkflowMilestoneDateFromRecord(
      poId,
      isWorkflowControllerState,
      'exited',
      'Workflow History Controller exit'
    );
  }

  function readWorkflowMilestoneDateFromRecord(poId, statePredicate, dateMode, source) {
    // These lists intentionally include several possible sublist/field spellings
    // seen across NetSuite workflow history implementations.
    const preferredSublistIds = [
      'workflowhistory',
      'workflowhistorylist',
      'workflowhistory_',
      'workflow_history'
    ];
    const stateFieldIds = [
      'statenameinfo',
      'statename',
      'state',
      'stateinfo',
      'state_name_info'
    ];
    const enteredFieldIds = [
      'dateenteredstate',
      'dateentered',
      'date_entered_state',
      'entereddate'
    ];
    const exitedFieldIds = [
      'dateexitedstate',
      'dateexited',
      'date_exited_state',
      'exiteddate'
    ];

    try {
      const poRec = record.load({
        type: record.Type.PURCHASE_ORDER,
        id: poId,
        isDynamic: false
      });

      const sublistIds = uniqueTruthy(preferredSublistIds.concat(getRecordSublistIds(poRec)));

      for (let s = 0; s < sublistIds.length; s++) {
        const sublistId = sublistIds[s];
        let lineCount = 0;

        try {
          lineCount = poRec.getLineCount({ sublistId: sublistId });
        } catch (e) {
          // Some guessed sublist IDs will not exist in the account. Treat those
          // as empty and continue probing the remaining candidates.
          lineCount = 0;
        }

        if (!lineCount) continue;

        const fieldIds = uniqueTruthy(getRecordSublistFieldIds(poRec, sublistId).concat(
          stateFieldIds,
          enteredFieldIds,
          exitedFieldIds
        ));
        // Merge discovered fields with known field names so hidden/variant columns
        // are still attempted when NetSuite exposes them.
        const best = readWorkflowMilestoneDateFromSublist(
          poRec,
          sublistId,
          lineCount,
          fieldIds,
          stateFieldIds,
          enteredFieldIds,
          exitedFieldIds,
          statePredicate,
          dateMode,
          source
        );

        if (best) return best;
      }
    } catch (e) {
      logWorkflowHistoryFallbackFailure(
        'PO approval Workflow History milestone date lookup failed',
        e,
        poId
      );
    }

    return null;
  }

  function readWorkflowMilestoneDateFromSublist(rec, sublistId, lineCount, fieldIds, stateFieldIds, enteredFieldIds, exitedFieldIds, statePredicate, dateMode, source) {
    let best = null;

    for (let line = 0; line < lineCount; line++) {
      const lineValues = readSublistLineValues(rec, sublistId, line, fieldIds);
      const stateName = readWorkflowStateNameMatching(lineValues, stateFieldIds, statePredicate);
      if (!statePredicate(stateName)) continue;

      // For approved-state milestones we use entry time; for Controller/Procurement
      // milestones we use exit time, depending on the caller's dateMode.
      const milestoneDate = dateMode === 'exited'
        ? readWorkflowExitedDate(lineValues, enteredFieldIds, exitedFieldIds)
        : readWorkflowEnteredDate(lineValues, enteredFieldIds);
      if (!milestoneDate || !milestoneDate.date) continue;

      if (!best || milestoneDate.date.getTime() > best.date.getTime()) {
        // Workflow history may include repeat visits to the same state. The report
        // wants the latest matching milestone because that is the final handoff.
        best = {
          date: milestoneDate.date,
          dateText: milestoneDate.text,
          source: source || 'Workflow History'
        };
      }
    }

    return best;
  }

  function recordWorkflowDate(outByPo, poId, date, dateText, source) {
    if (!outByPo || !poId || !date) return;

    const existing = outByPo[poId];
    // Preserve the latest date if multiple workflow rows match the same PO.
    if (existing && existing.date && existing.date.getTime() >= date.getTime()) return;

    outByPo[poId] = {
      date: date,
      dateText: formatDateTimeText(date, dateText),
      source: source || 'Workflow History'
    };
  }

  function recordProcurementApprovalWorkflowDate(outByPo, poId, stateName, date, dateText) {
    if (!outByPo || !poId || !date) return;

    const priority = getProcurementApprovalStatePriority(stateName);
    if (!priority) return;

    const existing = outByPo[poId];
    const existingPriority = Number(existing && existing.statePriority || 0);

    if (existing && existing.date) {
      if (existingPriority > priority) return;
      if (existingPriority === priority && existing.date.getTime() >= date.getTime()) return;
    }

    outByPo[poId] = {
      date: date,
      dateText: formatDateTimeText(date, dateText),
      source: priority === 2 ? 'Workflow History Procurement exit' : 'Workflow History Controller exit',
      statePriority: priority
    };
  }

  function getWorkflowHistorySearchSpecs() {
    // Submit-for-Approval timing needs both entry and exit dates, so this variant
    // list includes paired date fields in addition to join/state variants.
    const joins = ['workflowHistory', 'workflowhistory'];
    const stateFields = ['state', 'statenameinfo'];
    const datePairs = [
      ['dateenteredstate', 'dateexitedstate'],
      ['dateEnteredState', 'dateExitedState'],
      ['dateentered', 'dateexited']
    ];
    const specs = [];

    joins.forEach(joinId => {
      stateFields.forEach(stateField => {
        datePairs.forEach(pair => {
          specs.push({
            joinId: joinId,
            stateField: stateField,
            enteredField: pair[0],
            exitedField: pair[1]
          });
        });
      });
    });

    return specs;
  }

  function tryWorkflowHistorySearchSpec(spec, poIds, firstApprovalStartByPo, outByPo) {
    try {
      let sawReadableWorkflowState = false;
      const internalIdColumn = search.createColumn({ name: 'internalid', sort: search.Sort.ASC });
      const stateColumn = search.createColumn({ name: spec.stateField, join: spec.joinId });
      const enteredColumn = search.createColumn({ name: spec.enteredField, join: spec.joinId });
      const exitedColumn = search.createColumn({ name: spec.exitedField, join: spec.joinId });
      const wfSearch = search.create({
        type: search.Type.TRANSACTION,
        filters: [
          ['type', 'anyof', 'PurchOrd'],
          'AND',
          ['mainline', 'is', 'T'],
          'AND',
          ['internalid', 'anyof', poIds]
        ],
        columns: [internalIdColumn, stateColumn, enteredColumn, exitedColumn]
      });

      runPaged(wfSearch, result => {
        const poId = clean(result.getValue(internalIdColumn));
        if (!poId) return;

        const stateName = result.getText(stateColumn) || result.getValue(stateColumn);
        if (hasReadableWorkflowStateName(stateName)) sawReadableWorkflowState = true;
        if (!isSubmitForApprovalState(stateName)) return;

        const enteredRaw = result.getValue(enteredColumn);
        const exitedRaw = result.getValue(exitedColumn);
        const entered = parseNsDateTime(enteredRaw);
        const exited = parseNsDateTime(exitedRaw);

        if (!entered || !exited || exited.getTime() < entered.getTime()) return;

        const firstApprovalStart = firstApprovalStartByPo[poId];
        const firstStageDelta = firstApprovalStart ? Math.abs(exited.getTime() - firstApprovalStart.getTime()) : 0;
        // If several Submit for Approval rows exist, choose the one whose exit is
        // closest to the first approver-stage start.
        if (outByPo[poId] && Number(outByPo[poId].firstStageDelta || 0) <= firstStageDelta) return;

        outByPo[poId] = {
          start: entered,
          startText: formatDateTimeText(entered, enteredRaw),
          end: exited,
          endText: formatDateTimeText(exited, exitedRaw),
          source: 'Workflow History search',
          firstStageDelta: firstStageDelta
        };
      });
      return sawReadableWorkflowState;
    } catch (e) {
      return false;
    }
  }

  function shouldLoadWorkflowSubmitTiming(po, firstApprovalStage) {
    if (!firstApprovalStage || !firstApprovalStage.start) return false;

    const createdDate = parseNsDateTime(po && po.createdDate);
    // A zero-minute gap suggests the first approver stage inherited the PO created
    // date, so workflow history may reveal the real requestor submit interval.
    return !createdDate || diffMinutes(createdDate, firstApprovalStage.start) === 0;
  }

  function readWorkflowSubmitTimingFromRecord(poId, firstApprovalStage) {
    // Record-load fallback mirrors the joined-search strategy but reads the
    // workflow sublist directly when the join is unavailable.
    const preferredSublistIds = [
      'workflowhistory',
      'workflowhistorylist',
      'workflowhistory_',
      'workflow_history'
    ];
    const stateFieldIds = [
      'statenameinfo',
      'statename',
      'state',
      'stateinfo',
      'state_name_info'
    ];
    const enteredFieldIds = [
      'dateenteredstate',
      'dateentered',
      'date_entered_state',
      'entereddate'
    ];
    const exitedFieldIds = [
      'dateexitedstate',
      'dateexited',
      'date_exited_state',
      'exiteddate'
    ];
    const firstApprovalStart = firstApprovalStage && firstApprovalStage.start ? firstApprovalStage.start : null;

    try {
      const poRec = record.load({
        type: record.Type.PURCHASE_ORDER,
        id: poId,
        isDynamic: false
      });

      const sublistIds = uniqueTruthy(preferredSublistIds.concat(getRecordSublistIds(poRec)));

      for (let s = 0; s < sublistIds.length; s++) {
        const sublistId = sublistIds[s];
        let lineCount = 0;

        try {
          lineCount = poRec.getLineCount({ sublistId: sublistId });
        } catch (e) {
          lineCount = 0;
        }

        if (!lineCount) continue;

        const fieldIds = uniqueTruthy(getRecordSublistFieldIds(poRec, sublistId).concat(
          stateFieldIds,
          enteredFieldIds,
          exitedFieldIds
        ));
        const best = readWorkflowSubmitTimingFromSublist(
          poRec,
          sublistId,
          lineCount,
          fieldIds,
          stateFieldIds,
          enteredFieldIds,
          exitedFieldIds,
          firstApprovalStart
        );

        if (best) {
          return best;
        }
      }
    } catch (e) {
      logWorkflowHistoryFallbackFailure(
        'PO approval Workflow History requestor lookup failed',
        e,
        poId
      );
    }

    return null;
  }

  function readWorkflowSubmitTimingFromSublist(rec, sublistId, lineCount, fieldIds, stateFieldIds, enteredFieldIds, exitedFieldIds, firstApprovalStart) {
    let best = null;

    for (let line = 0; line < lineCount; line++) {
      const lineValues = readSublistLineValues(rec, sublistId, line, fieldIds);
      const stateName = readWorkflowStateName(lineValues, stateFieldIds);
      if (!isSubmitForApprovalState(stateName)) continue;

      const dates = readWorkflowLineDates(lineValues, enteredFieldIds, exitedFieldIds);
      if (!dates || !dates.entered || !dates.exited || dates.exited.getTime() < dates.entered.getTime()) continue;

      const firstStageDelta = firstApprovalStart ? Math.abs(dates.exited.getTime() - firstApprovalStart.getTime()) : 0;
      // The submit row that exits closest to the first approver start is the best
      // proxy for the requestor's Submit for Approval action.
      if (!best || firstStageDelta < best.firstStageDelta) {
        best = {
          start: dates.entered,
          startText: dates.enteredText,
          end: dates.exited,
          endText: dates.exitedText,
          source: 'Workflow History',
          firstStageDelta: firstStageDelta
        };
      }
    }

    if (best) delete best.firstStageDelta;
    return best;
  }

  function getRecordSublistIds(rec) {
    try {
      return rec.getSublists() || [];
    } catch (e) {
      return [];
    }
  }

  function getRecordSublistFieldIds(rec, sublistId) {
    try {
      return rec.getSublistFields({ sublistId: sublistId }) || [];
    } catch (e) {
      return [];
    }
  }

  function readSublistLineValues(rec, sublistId, line, fieldIds) {
    const values = [];

    (fieldIds || []).forEach(fieldId => {
      // Store only fields that returned meaningful values so the later date/state
      // scanners can work against a compact array.
      const value = readSublistValue(rec, sublistId, line, fieldId);
      if (isEmptyValue(value)) return;
      values.push({
        fieldId: fieldId,
        value: value
      });
    });

    return values;
  }

  function readSublistValue(rec, sublistId, line, fieldId) {
    let value = '';

    try {
      // Prefer display text because workflow states and employee fields are easier
      // to match by text than by internal ID.
      value = rec.getSublistText({
        sublistId: sublistId,
        fieldId: fieldId,
        line: line
      });
    } catch (e) { }

    if (isEmptyValue(value)) {
      try {
        // Fall back to raw values for date fields and cases where getSublistText
        // is not supported by the column.
        value = rec.getSublistValue({
          sublistId: sublistId,
          fieldId: fieldId,
          line: line
        });
      } catch (e) { }
    }

    return isNullAdapterValue(value) ? '' : value;
  }

  function readWorkflowStateName(lineValues, stateFieldIds) {
    return readWorkflowStateNameMatching(lineValues, stateFieldIds, isSubmitForApprovalState);
  }

  function readWorkflowStateNameMatching(lineValues, stateFieldIds, statePredicate) {
    const fromKnownField = readLineValueByFieldIds(lineValues, stateFieldIds);
    if (fromKnownField) return fromKnownField;

    // If the expected state field name was not found, scan every populated value
    // and accept the first one that matches the caller's state predicate.
    for (let i = 0; i < lineValues.length; i++) {
      if (statePredicate(lineValues[i].value)) return lineValues[i].value;
    }

    return '';
  }

  function readWorkflowLineDates(lineValues, enteredFieldIds, exitedFieldIds) {
    const enteredRaw = readLineValueByFieldIds(lineValues, enteredFieldIds);
    const exitedRaw = readLineValueByFieldIds(lineValues, exitedFieldIds);
    const entered = parseWorkflowDate(enteredRaw);
    const exited = parseWorkflowDate(exitedRaw);

    if (entered && exited) {
      // Best case: the expected entry and exit fields were readable.
      return {
        entered: entered,
        enteredText: formatDateTimeText(entered, clean(enteredRaw)),
        exited: exited,
        exitedText: formatDateTimeText(exited, clean(exitedRaw))
      };
    }

    const dateValues = [];
    (lineValues || []).forEach(item => {
      const parsed = parseWorkflowDate(item.value);
      if (!parsed) return;
      dateValues.push({
        date: parsed,
        text: formatDateTimeText(parsed, clean(item.value))
      });
    });

    if (dateValues.length < 2) return null;

    // Last resort: use the earliest and latest dates on the workflow line as
    // approximate entry/exit values.
    dateValues.sort((a, b) => a.date.getTime() - b.date.getTime());
    return {
      entered: dateValues[0].date,
      enteredText: dateValues[0].text,
      exited: dateValues[dateValues.length - 1].date,
      exitedText: dateValues[dateValues.length - 1].text
    };
  }

  function readWorkflowEnteredDate(lineValues, enteredFieldIds) {
    const enteredRaw = readLineValueByFieldIds(lineValues, enteredFieldIds);
    const entered = parseWorkflowDate(enteredRaw);

    if (entered) {
      // Prefer the named "entered" field when present.
      return {
        date: entered,
        text: formatDateTimeText(entered, clean(enteredRaw))
      };
    }

    const dateValues = [];
    (lineValues || []).forEach(item => {
      const parsed = parseWorkflowDate(item.value);
      if (!parsed) return;
      dateValues.push({
        date: parsed,
        text: formatDateTimeText(parsed, clean(item.value))
      });
    });

    if (!dateValues.length) return null;

    // Without a named entry field, the earliest date on the line is the safest
    // approximation for when the state began.
    dateValues.sort((a, b) => a.date.getTime() - b.date.getTime());
    return dateValues[0];
  }

  function readWorkflowExitedDate(lineValues, enteredFieldIds, exitedFieldIds) {
    const exitedRaw = readLineValueByFieldIds(lineValues, exitedFieldIds);
    const exited = parseWorkflowDate(exitedRaw);

    if (exited) {
      // Prefer the named "exited" field when present.
      return {
        date: exited,
        text: formatDateTimeText(exited, clean(exitedRaw))
      };
    }

    const dates = readWorkflowLineDates(lineValues, enteredFieldIds, exitedFieldIds);
    if (!dates || !dates.exited) return null;

    return {
      date: dates.exited,
      text: dates.exitedText
    };
  }

  function readLineValueByFieldIds(lineValues, fieldIds) {
    const wanted = {};
    (fieldIds || []).forEach(fieldId => {
      wanted[normalizeFieldName(fieldId)] = true;
    });

    for (let i = 0; i < lineValues.length; i++) {
      const item = lineValues[i];
      if (wanted[normalizeFieldName(item.fieldId)] && !isEmptyValue(item.value)) return item.value;
    }

    return '';
  }

  function parseWorkflowDate(value) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    const text = clean(value);
    // Avoid handing non-date workflow values to NetSuite's date parser.
    if (!text || !/[0-9]{1,4}[\/-][0-9]{1,2}[\/-][0-9]{1,4}/.test(text)) return null;
    return parseNsDateTime(text);
  }

  function readFirstSublistValue(rec, sublistId, line, fieldIds) {
    for (let i = 0; i < fieldIds.length; i++) {
      const fieldId = fieldIds[i];
      let value = '';

      try {
        value = rec.getSublistText({
          sublistId: sublistId,
          fieldId: fieldId,
          line: line
        });
      } catch (e) { }

      if (!value) {
        try {
          value = rec.getSublistValue({
            sublistId: sublistId,
            fieldId: fieldId,
            line: line
          });
        } catch (e) { }
      }

      if (value) return value;
    }

    return '';
  }

  function isSubmitForApprovalState(stateName) {
    // Normalized comparisons tolerate NetSuite labels with spaces, punctuation, or
    // different casing.
    return normalizeFieldName(stateName) === 'submitforapproval';
  }

  function isWorkflowApprovedState(stateName) {
    // The workflow approved state supplies the PO Order Date milestone.
    return normalizeFieldName(stateName) === 'approved';
  }

  function isWorkflowControllerState(stateName) {
    const normalizedState = normalizeFieldName(stateName);
    return normalizedState === 'controller' || normalizedState === 'procurement';
  }

  function getProcurementApprovalStatePriority(stateName) {
    const normalizedState = normalizeFieldName(stateName);
    if (normalizedState === 'procurement') return 2;
    if (normalizedState === 'controller') return 1;
    return 0;
  }

  function hasReadableWorkflowStateName(stateName) {
    // Used to tell the caller whether a workflow-history search spec was viable,
    // even when no rows matched the target state.
    return /[a-z]/.test(normalizeFieldName(stateName));
  }

  function loadSystemNoteStagesForPurchaseOrders(poIds) {
    const eventsByPo = {};
    const chunks = chunkArray(poIds, CONFIG.systemNoteBatchSize);

    try {
      chunks.forEach(idChunk => {
        // System Notes are queried through the transaction search because direct
        // system note search access is not consistently available for all roles.
        const txSearch = search.create({
          type: search.Type.TRANSACTION,
          filters: [
            ['type', 'anyof', 'PurchOrd'],
            'AND',
            ['mainline', 'is', 'T'],
            'AND',
            ['internalid', 'anyof', idChunk]
          ],
          columns: [
            search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
            search.createColumn({ name: 'date', join: 'systemNotes', sort: search.Sort.ASC }),
            search.createColumn({ name: 'name', join: 'systemNotes' }),
            search.createColumn({ name: 'field', join: 'systemNotes' }),
            search.createColumn({ name: 'oldvalue', join: 'systemNotes' }),
            search.createColumn({ name: 'newvalue', join: 'systemNotes' })
          ]
        });

        runPaged(txSearch, result => {
          const poId = String(result.getValue('internalid') || '');
          const dateText = result.getValue({ name: 'date', join: 'systemNotes' }) || '';
          const fieldName = result.getValue({ name: 'field', join: 'systemNotes' }) || '';

          // Only fields that can affect the approval chain are retained; this
          // keeps noisy edit history out of fallback stage reconstruction.
          if (!poId || !dateText || !isRelevantSystemNoteField(fieldName)) return;

          const event = {
            poId: poId,
            date: parseNsDateTime(dateText),
            dateText: dateText,
            setBy: result.getText({ name: 'name', join: 'systemNotes' }) ||
              result.getValue({ name: 'name', join: 'systemNotes' }) || '',
            field: fieldName,
            oldValue: result.getValue({ name: 'oldvalue', join: 'systemNotes' }) || '',
            newValue: result.getValue({ name: 'newvalue', join: 'systemNotes' }) || ''
          };

          if (!event.date) return;
          if (!eventsByPo[poId]) eventsByPo[poId] = [];
          eventsByPo[poId].push(event);
        });
      });
    } catch (e) {
      log.error({
        title: 'PO approval System Notes fallback failed',
        details: describeError(e)
      });
      return {};
    }

    const employeeMap = getEmployeeNameMap(collectSystemNoteApproverIds(eventsByPo));
    const byPo = {};

    Object.keys(eventsByPo).forEach(poId => {
      // Convert raw field-change events into start/end stage intervals.
      const stages = buildStagesFromSystemNoteEvents(eventsByPo[poId], employeeMap);
      if (stages.length) byPo[poId] = decorateFallbackStages(stages);
    });

    return byPo;
  }

  function loadRequestorStartTimesForPurchaseOrders(poRows) {
    const byPo = {};
    const poIds = uniqueTruthy((poRows || []).map(row => row && row.internalId ? row.internalId : row));
    const chunks = chunkArray(poIds, CONFIG.systemNoteBatchSize);

    if (!poIds.length) return byPo;

    try {
      chunks.forEach(idChunk => {
        // The first System Note approximates the earliest visible PO activity when
        // workflow submit history cannot be read.
        const txSearch = search.create({
          type: search.Type.TRANSACTION,
          filters: [
            ['type', 'anyof', 'PurchOrd'],
            'AND',
            ['mainline', 'is', 'T'],
            'AND',
            ['internalid', 'anyof', idChunk]
          ],
          columns: [
            search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
            search.createColumn({ name: 'date', join: 'systemNotes', sort: search.Sort.ASC }),
            search.createColumn({ name: 'name', join: 'systemNotes' })
          ]
        });

        runPaged(txSearch, result => {
          const poId = String(result.getValue('internalid') || '');
          const dateText = result.getValue({ name: 'date', join: 'systemNotes' }) || '';
          const date = parseNsDateTime(dateText);

          // Keep the first note per PO because the search is sorted ascending by
          // System Notes date.
          if (!poId || !date || byPo[poId]) return;

          byPo[poId] = {
            start: date,
            startText: dateText,
            setBy: result.getText({ name: 'name', join: 'systemNotes' }) ||
              result.getValue({ name: 'name', join: 'systemNotes' }) || ''
          };
        });
      });
    } catch (e) {
      log.error({
        title: 'PO approval requestor System Notes start lookup failed',
        details: describeError(e)
      });
    }

    return byPo;
  }

  function buildRequestorTiming(po, stages, workflowSubmitTiming, systemNoteStart) {
    const createdDate = parseNsDateTime(po && po.createdDate);
    const firstApprovalStage = getFirstApprovalStage(stages);
    const firstApprovalStart = firstApprovalStage && firstApprovalStage.start ? firstApprovalStage.start : null;
    const end = firstApprovalStart || createdDate;

    if (
      workflowSubmitTiming &&
      workflowSubmitTiming.start &&
      workflowSubmitTiming.end &&
      workflowSubmitTiming.end.getTime() >= workflowSubmitTiming.start.getTime()
    ) {
      // Workflow history is the best source for requestor time because it captures
      // Submit for Approval entry and exit as explicit workflow state dates.
      return {
        start: workflowSubmitTiming.start,
        startText: workflowSubmitTiming.startText || formatDateTimeText(workflowSubmitTiming.start, ''),
        end: workflowSubmitTiming.end,
        endText: workflowSubmitTiming.endText || formatDateTimeText(workflowSubmitTiming.end, ''),
        source: workflowSubmitTiming.source || 'Workflow History'
      };
    }

    let start = createdDate;
    let startText = po && po.createdDate ? po.createdDate : '';
    let source = 'PO created date';

    if (systemNoteStart && systemNoteStart.start && end && systemNoteStart.start.getTime() < end.getTime()) {
      // If the first System Note predates the first approver stage, it is a better
      // requestor-start proxy than the PO header created timestamp.
      start = systemNoteStart.start;
      startText = systemNoteStart.startText || formatDateTimeText(systemNoteStart.start, '');
      source = 'First PO System Note';
    }

    // Do not emit negative or incomplete intervals; the dashboard can still show
    // approval stages without a requestor timing row.
    if (!start || !end || end.getTime() < start.getTime()) return null;

    return {
      start: start,
      startText: startText,
      end: end,
      endText: firstApprovalStage && firstApprovalStage.startText
        ? firstApprovalStage.startText
        : formatDateTimeText(end, po && po.createdDate ? po.createdDate : ''),
      source: source
    };
  }

  function buildStagesFromSystemNoteEvents(events, employeeMap) {
    // Reconstruct approval stages from the chronological stream of next approver,
    // approver role, and document status changes.
    const sorted = (events || []).slice().sort((a, b) => a.date.getTime() - b.date.getTime());
    const stages = [];

    let currentApprover = '';
    let currentRole = '';
    let currentStart = null;
    let currentStartText = '';
    let currentStatus = '';
    let lastBoundaryDate = null;
    let lastBoundaryText = '';

    sorted.forEach(event => {
      const normalizedField = normalizeFieldName(event.field);

      if (isNextApproverRoleField(normalizedField)) {
        // Role changes are metadata for the next approver stage, not a stage
        // boundary by themselves.
        currentRole = event.newValue || currentRole;
        lastBoundaryDate = event.date || lastBoundaryDate;
        lastBoundaryText = event.dateText || lastBoundaryText;
        return;
      }

      if (isNextApproverField(normalizedField)) {
        const oldApprover = event.oldValue ? resolveSystemNoteApproverName(event.oldValue, employeeMap) : '';
        const newApprover = event.newValue ? resolveSystemNoteApproverName(event.newValue, employeeMap) : '';

        if (currentApprover && currentStart) {
          // A new next approver closes the current approver's interval.
          stages.push(makeFallbackStage({
            approverText: currentApprover,
            role: currentRole,
            start: currentStart,
            startText: currentStartText,
            end: event.date,
            endText: event.dateText,
            status: currentStatus,
            endReason: event.newValue ? 'Reassigned to next approver' : 'Next approver cleared',
            isCurrent: false
          }));
        } else if (oldApprover && !sameCleanText(oldApprover, newApprover)) {
          const fallbackStart = lastBoundaryDate || event.date;
          // Some System Notes only expose the old approver on the handoff event.
          // In that case, use the previous boundary as a conservative start time.
          stages.push(makeFallbackStage({
            approverText: oldApprover,
            role: currentRole,
            start: fallbackStart,
            startText: lastBoundaryText || event.dateText,
            end: event.date,
            endText: event.dateText,
            status: currentStatus,
            endReason: event.newValue ? 'Reassigned to next approver' : 'Next approver cleared',
            isCurrent: false
          }));
        }

        currentApprover = newApprover;
        currentStart = newApprover ? event.date : null;
        currentStartText = newApprover ? event.dateText : '';
        lastBoundaryDate = event.date || lastBoundaryDate;
        lastBoundaryText = event.dateText || lastBoundaryText;
        return;
      }

      if (isDocStatusField(normalizedField)) {
        currentStatus = event.newValue || currentStatus;

        if (isApprovedStatus(event.newValue) && currentApprover && currentStart) {
          // Approval status closes the final approver interval when next approver
          // is not separately cleared.
          stages.push(makeFallbackStage({
            approverText: currentApprover,
            role: currentRole,
            start: currentStart,
            startText: currentStartText,
            end: event.date,
            endText: event.dateText,
            status: event.newValue,
            endReason: 'Approval completed',
            isCurrent: false
          }));
          currentApprover = '';
          currentStart = null;
          currentStartText = '';
        }

        lastBoundaryDate = event.date || lastBoundaryDate;
        lastBoundaryText = event.dateText || lastBoundaryText;
      }
    });

    if (currentApprover && currentStart) {
      const now = new Date();
      // If a next approver remains open, show it as the current active fallback
      // stage ending at "now" so elapsed time is visible.
      stages.push(makeFallbackStage({
        approverText: currentApprover,
        role: currentRole,
        start: currentStart,
        startText: currentStartText,
        end: now,
        endText: formatDateTimeText(now, ''),
        status: currentStatus,
        endReason: 'Current approver from System Notes',
        isCurrent: true
      }));
    }

    return stages;
  }

  function makeFallbackStage(opts) {
    // Fallback stages match the persisted-stage shape so downstream rendering and
    // exports do not care where the stage came from.
    const calendarMins = diffMinutes(opts.start, opts.end);
    const businessMins = businessMinutesBetween(opts.start, opts.end);

    return {
      seq: 0,
      displaySeq: 0,
      approverText: opts.approverText || 'Unknown',
      role: opts.role || 'Role not captured',
      start: opts.start || null,
      startText: opts.startText || '',
      end: opts.end || null,
      endText: opts.endText || '',
      calendarMins: calendarMins,
      businessMins: businessMins,
      waitMins: Math.max(0, calendarMins - businessMins),
      status: opts.status || '',
      endReason: opts.endReason || 'System Notes fallback',
      isCurrent: !!opts.isCurrent,
      transitionType: 'System Notes fallback',
      slaBreached: false,
      isBottleneck: false
    };
  }

  function decorateFallbackStages(stages) {
    let maxBusiness = 0;

    // Fallback reconstruction does not have stored sequence/bottleneck fields, so
    // decorate after the full stage list is known.
    stages.forEach(stage => {
      maxBusiness = Math.max(maxBusiness, Number(stage.businessMins || 0));
    });

    stages.forEach((stage, idx) => {
      stage.seq = idx + 1;
      stage.displaySeq = idx + 1;
      stage.isBottleneck = maxBusiness > 0 && Number(stage.businessMins || 0) === maxBusiness;
    });

    return stages;
  }

  function buildCurrentApproverFallbackStages(po) {
    // Final fallback for pending POs when neither child stages nor System Notes
    // produced a timeline.
    if (!po || isApprovedStatus(po.approvalStatus) || isTerminalTransactionStatus(po.transactionStatus)) {
      return [];
    }

    if (!po.nextApprover && !isPendingApprovalStatus(po.approvalStatus, po.transactionStatus)) {
      return [];
    }

    const start = parseNsDateTime(po.createdDate) || parseDateParam(po.tranDate) || new Date();
    const now = new Date();

    // Use the PO header next approver as the active stage and measure from the best
    // available PO start date to current time.
    return decorateFallbackStages([
      makeFallbackStage({
        approverText: po.nextApprover || 'Pending Approval',
        role: po.nextApproverRole || po.transactionStatus || 'Approval',
        start: start,
        startText: po.createdDate || po.tranDate || '',
        end: now,
        endText: formatDateTimeText(now, ''),
        status: po.approvalStatus || po.transactionStatus || 'Pending Approval',
        endReason: po.nextApprover ? 'Current approver from PO header' : 'PO is pending approval',
        isCurrent: true
      })
    ]);
  }

  function buildPurchaseOrderSummary(po, stages, requestorTiming, procurementApprovalDate, poOrderDate) {
    // Summary rows are the single normalized data contract consumed by dashboard,
    // CSV, and Excel renderers.
    stages = removeRedundantZeroMinuteDuplicateStages(stages || []);

    let totalBusiness = 0;
    let totalCalendar = 0;
    let totalWait = 0;
    let openStage = null;
    let bottleneck = null;
    let firstStart = null;
    let lastEnd = null;
    const procurementDate = normalizeProcurementApprovalDate(procurementApprovalDate);
    const orderDate = normalizePoOrderDate(po, poOrderDate);
    const prSubmissionDate = normalizePrSubmissionDate(requestorTiming);

    stages.forEach(stage => {
      // Aggregate all timing values at the PO level and find key stages for cards
      // and KPI pills.
      totalBusiness += Number(stage.businessMins || 0);
      totalCalendar += Number(stage.calendarMins || 0);
      totalWait += Number(stage.waitMins || 0);

      if (stage.isCurrent) openStage = stage;
      if (stage.isBottleneck && !bottleneck) bottleneck = stage;
      if (stage.start && (!firstStart || stage.start < firstStart)) firstStart = stage.start;
      if (stage.end && (!lastEnd || stage.end > lastEnd)) lastEnd = stage.end;
    });

    if (!bottleneck && stages.length) {
      // If no source marked a bottleneck, infer it from the largest business-time
      // stage so the dashboard always has a longest-stage answer.
      bottleneck = stages.slice().sort((a, b) => Number(b.businessMins || 0) - Number(a.businessMins || 0))[0];
    }

    return {
      internalId: po.internalId,
      tranId: po.tranId,
      vendor: po.vendor,
      tranDate: po.tranDate,
      createdDate: po.createdDate,
      prSubmissionDate: prSubmissionDate.date,
      prSubmissionDateText: prSubmissionDate.dateText,
      prSubmissionDateSource: prSubmissionDate.source,
      approvalDate: po.approvalDate || '',
      procurementApprovalDate: procurementDate.date,
      procurementApprovalDateText: procurementDate.dateText,
      procurementApprovalDateSource: procurementDate.source,
      poOrderDate: orderDate.date,
      poOrderDateText: orderDate.dateText,
      poOrderDateSource: orderDate.source,
      approvalStatus: po.approvalStatus,
      transactionStatus: po.transactionStatus,
      amount: po.amount,
      requestor: po.requestor || 'Unknown',
      orderCreator: po.orderCreator || '',
      requestorTiming: requestorTiming || null,
      url: po.url,
      stages: stages,
      totalBusinessMins: totalBusiness,
      totalCalendarMins: totalCalendar,
      totalWaitMins: totalWait,
      firstStart: firstStart,
      lastEnd: lastEnd,
      openStage: openStage,
      bottleneck: bottleneck,
      isApproved: isApprovedStatus(po.approvalStatus),
      hasTimeline: stages.length > 0
    };
  }

  function removeRedundantZeroMinuteDuplicateStages(stages) {
    // System Notes can emit a zero-minute duplicate when a handoff and clear happen
    // at the same timestamp. Remove only adjacent duplicates for the same approver.
    const filtered = [];

    (stages || []).forEach(stage => {
      if (isRedundantZeroMinuteDuplicateStage(filtered, stage)) return;
      filtered.push(stage);
    });

    filtered.forEach((stage, idx) => {
      stage.displaySeq = idx + 1;
    });

    return filtered;
  }

  function isRedundantZeroMinuteDuplicateStage(existingStages, stage) {
    const approver = clean(stage && stage.approverText);
    const start = stage ? toDate(stage.start) : null;
    const end = stage ? toDate(stage.end) : null;

    if (!approver || !start || !end) return false;
    if (start.getTime() !== end.getTime()) return false;
    if (Number(stage.calendarMins || 0) !== 0 || Number(stage.businessMins || 0) !== 0) return false;

    // Walk backward only through stages that ended at the same moment. Once the
    // timestamp differs, the duplicate window has ended.
    for (let i = existingStages.length - 1; i >= 0; i--) {
      const previousStage = existingStages[i];
      const previousEnd = previousStage ? toDate(previousStage.end) : null;
      if (!previousEnd) continue;

      if (previousEnd.getTime() !== start.getTime()) {
        break;
      }

      if (sameCleanText(previousStage.approverText, approver)) {
        return true;
      }
    }

    return false;
  }

  function normalizePrSubmissionDate(requestorTiming) {
    // PR Submission Date is represented by the end of the requestor/creator
    // interval, not the beginning.
    if (requestorTiming && requestorTiming.end) {
      return {
        date: requestorTiming.end,
        dateText: requestorTiming.endText || formatDateTimeText(requestorTiming.end, ''),
        source: requestorTiming.source || 'Requestor timing'
      };
    }

    return {
      date: null,
      dateText: '',
      source: ''
    };
  }

  function normalizeProcurementApprovalDate(workflowApprovalDate) {
    // Procurement Approval Date comes from the Procurement workflow state exit;
    // Controller is retained only as a fallback for older workflow naming.
    if (workflowApprovalDate && workflowApprovalDate.date) {
      return {
        date: workflowApprovalDate.date,
        dateText: workflowApprovalDate.dateText || formatDateTimeText(workflowApprovalDate.date, ''),
        source: workflowApprovalDate.source || 'Workflow History Procurement exit'
      };
    }

    return {
      date: null,
      dateText: '',
      source: ''
    };
  }

  function normalizePoOrderDate(po, workflowOrderDate) {
    // Prefer the workflow approved-state date. Fall back to the PO header approval
    // date for accounts where workflow history cannot be queried.
    if (workflowOrderDate && workflowOrderDate.date) {
      return {
        date: workflowOrderDate.date,
        dateText: workflowOrderDate.dateText || formatDateTimeText(workflowOrderDate.date, ''),
        source: workflowOrderDate.source || 'Workflow History approved state'
      };
    }

    const headerText = clean(po && po.approvalDate);
    const headerDate = parseNsDateTime(headerText);

    return {
      date: headerDate,
      dateText: headerText,
      source: headerText ? 'PO approval date' : ''
    };
  }

  function buildSummary(rows) {
    // Summary metrics intentionally run over the rows currently loaded for the
    // page, matching what the user can see/export from this Suitelet response.
    let amountTotal = 0;
    let approvedCount = 0;
    let openCount = 0;
    let noTimelineCount = 0;
    let totalBusiness = 0;
    let totalCalendar = 0;
    let businessPoCount = 0;
    let longestPo = null;
    let longestStage = null;

    rows.forEach(row => {
      amountTotal += Number(row.amount || 0);
      if (row.isApproved) approvedCount += 1;
      else openCount += 1;
      if (!row.hasTimeline) noTimelineCount += 1;

      totalBusiness += Number(row.totalBusinessMins || 0);
      totalCalendar += Number(row.totalCalendarMins || 0);
      if (row.totalBusinessMins > 0) businessPoCount += 1;

      if (!longestPo || row.totalBusinessMins > longestPo.totalBusinessMins) {
        longestPo = row;
      }

      row.stages.forEach(stage => {
        // longestStage keeps the containing PO so the hero can show both PO number
        // and stage number.
        if (!longestStage || Number(stage.businessMins || 0) > Number(longestStage.stage.businessMins || 0)) {
          longestStage = {
            po: row,
            stage: stage
          };
        }
      });
    });

    return {
      poCount: rows.length,
      approvedCount: approvedCount,
      openCount: openCount,
      noTimelineCount: noTimelineCount,
      amountTotal: amountTotal,
      avgBusinessMins: businessPoCount ? Math.round(totalBusiness / businessPoCount) : 0,
      avgCalendarMins: businessPoCount ? Math.round(totalCalendar / businessPoCount) : 0,
      longestPo: longestPo,
      longestStage: longestStage
    };
  }

  function buildDashboardHtml(data) {
    // Dashboard HTML is assembled in sections so the same normalized data can
    // support hero KPIs, pagination, and the wide timeline table.
    const tableRows = buildTimelineWideDisplayRows(data);
    const rowsHtml = tableRows.length
      ? buildTimelineTableHtml(tableRows)
      : buildEmptyState(data.filters);
    const paginationHtml = buildPaginationHtml(data);

    return `
      ${buildCss()}
      <div class="pa-wrap">
        ${buildHero(data)}
        ${buildKpiGrid(data)}
        <div class="pa-section-head">
          <div>
            <div class="pa-section-title">Purchase Orders</div>
            <div class="pa-section-subtitle">Transaction date ${esc(data.filters.dateFromText)} through ${esc(data.filters.dateToText)}</div>
          </div>
          <div class="pa-count">${esc(buildPageCountText(data.pagination, data.rows.length, tableRows.length))}</div>
        </div>
        ${paginationHtml}
        ${rowsHtml}
        ${paginationHtml}
        ${buildDashboardFooterHtml()}
      </div>`;
  }

  function buildDashboardFooterHtml() {
    // Keep version/developer metadata visible in the rendered report for support
    // screenshots and export comparisons.
    return `
      <div class="pa-footer-meta">
        <span class="pa-pill">Version: ${esc(CONFIG.version)}</span>
        <span class="pa-pill">Developer: ${esc(CONFIG.developerName)}</span>
      </div>`;
  }

  function buildPageCountText(pagination, poCount, detailRowCount) {
    // Detail row count may differ from PO count when future table modes display
    // multiple stage rows per PO.
    if (pagination && pagination.totalCount) {
      return 'Loaded ' + String(pagination.start) + '-' + String(pagination.end) +
        ' of ' + String(pagination.totalCount) + ' POs / ' + String(detailRowCount) + ' PO rows shown';
    }

    return String(poCount) + ' POs / ' + String(detailRowCount) + ' PO rows shown';
  }

  function buildPaginationHtml(data) {
    const pagination = data.pagination || {};
    if (!pagination.totalCount || pagination.pageCount <= 1) return '';

    // Pagination operates over purchase orders, not stage rows.
    const prevEnabled = pagination.pageIndex > 0;
    const nextEnabled = pagination.pageIndex < pagination.pageCount - 1;
    const prevUrl = prevEnabled ? buildPageUrl(data.filters, pagination.pageIndex - 1) : '';
    const nextUrl = nextEnabled ? buildPageUrl(data.filters, pagination.pageIndex + 1) : '';

    return `
      <div class="pa-pager">
        <div class="pa-page-status">Page ${esc(String(pagination.pageNumber))} of ${esc(String(pagination.pageCount))} - ${esc(String(pagination.pageSize))} POs per page</div>
        <div class="pa-page-actions">
          ${buildPageButton('Previous 100', prevUrl, prevEnabled)}
          ${buildPageButton('Next 100', nextUrl, nextEnabled)}
        </div>
      </div>`;
  }

  function buildPageButton(label, href, enabled) {
    // Disabled pager controls render as spans so NetSuite does not navigate to an
    // empty/invalid Suitelet URL.
    if (!enabled) {
      return '<span class="pa-page-btn disabled">' + esc(label) + '</span>';
    }

    return '<a class="pa-page-btn" href="' + escAttr(href) + '">' + esc(label) + '</a>';
  }

  function buildPageUrl(filters, pageIndex) {
    // Preserve every filter when changing pages, including the collapsed-stage
    // view preference.
    const currentScript = runtime.getCurrentScript();
    return url.resolveScript({
      scriptId: currentScript.id,
      deploymentId: currentScript.deploymentId,
      params: {
        custpage_datefrom: filters.dateFromText,
        custpage_dateto: filters.dateToText,
        custpage_search: filters.searchText || '',
        custpage_timelineonly: filters.timelineOnly ? 'T' : 'F',
        custpage_collapsestagelines: filters.collapseStageLines ? 'T' : 'F',
        custpage_page: String(Math.max(0, Number(pageIndex || 0)))
      }
    });
  }

  function buildHero(data) {
    // The hero gives quick operational context: date window, visible PO count,
    // approval split, and the longest visible approval stage.
    const filters = data.filters;
    const summary = data.summary;
    const pagination = data.pagination || {};
    const longest = summary.longestStage;

    return `
      <div class="pa-hero">
        <div>
          <div class="pa-title">PO Approval Timeline</div>
          <div class="pa-subtitle">All purchase orders in the selected 30-day window, with stage timing from captured approval stages or PO System Notes.</div>
        </div>
        <div class="pa-hero-meta">
          <span class="pa-pill">${esc(filters.dateFromText)} - ${esc(filters.dateToText)}</span>
          <span class="pa-pill">${esc(String(summary.poCount))} POs shown</span>
          ${pagination.totalCount ? '<span class="pa-pill">' + esc(String(pagination.totalCount)) + ' total POs</span>' : ''}
          <span class="pa-pill pa-pill-green">${esc(String(summary.approvedCount))} approved</span>
          <span class="pa-pill pa-pill-amber">${esc(String(summary.openCount))} open/non-approved</span>
          ${longest ? '<span class="pa-pill pa-pill-amber">Longest stage: ' + esc(longest.po.tranId) + ' ' + esc(formatStageNumber(longest.stage.displaySeq || longest.stage.seq || '')) + '</span>' : ''}
        </div>
      </div>`;
  }

  function buildKpiGrid(data) {
    // KPIs are current-page metrics by design; full date-window totals would
    // require loading every page and would make the Suitelet slower.
    const summary = data.summary;
    const longestPo = summary.longestPo;

    return `
      <div class="pa-kpis">
        ${buildKpi('PO Count', summary.poCount, 'POs on current page', 'blue')}
        ${buildKpi('Total Amount', '$' + formatCurrency(summary.amountTotal), 'Current page amount', 'teal')}
        ${buildKpi('Avg Business Time', formatMinutes(summary.avgBusinessMins), 'POs with captured stages', 'green')}
        ${buildKpi('Avg Calendar Time', formatMinutes(summary.avgCalendarMins), 'POs with captured stages', 'slate')}
        ${buildKpi('Missing Timeline', summary.noTimelineCount, 'Current page only', 'amber')}
        ${buildKpi('Longest PO', longestPo && longestPo.totalBusinessMins > 0 ? longestPo.tranId : '-', longestPo && longestPo.totalBusinessMins > 0 ? formatMinutes(longestPo.totalBusinessMins) : 'No timing captured', 'orange')}
      </div>`;
  }

  function buildKpi(label, value, sublabel, tone) {
    // Tone classes are escaped even though they are generated internally because
    // the helper is used as a generic HTML builder.
    return `
      <div class="pa-kpi ${escAttr('tone-' + tone)}">
        <div class="pa-kpi-label">${esc(label)}</div>
        <div class="pa-kpi-value">${esc(value)}</div>
        <div class="pa-kpi-sub">${esc(sublabel)}</div>
      </div>`;
  }

  function buildTimelineDisplayRows(data) {
    // Legacy row-per-stage shape retained for CSV and any older card/table layouts
    // that need repeated PO fields only on the first stage row.
    const rows = [];
    const collapseStageLines = !!(data && data.filters && data.filters.collapseStageLines);

    data.rows.forEach((row, idx) => {
      const poTone = String(idx % 8);
      const displayStages = buildDisplayStages(row);

      if (!displayStages.length) {
        rows.push(buildTimelineDisplayRow(row, null, poTone, true));
        return;
      }

      displayStages.forEach((stage, stageIdx) => {
        if (shouldHideCollapsedDisplayStage(stage, collapseStageLines)) return;
        rows.push(buildTimelineDisplayRow(row, stage, poTone, stageIdx === 0));
      });
    });

    return rows;
  }

  function buildTimelineWideDisplayRows(data) {
    // The active on-screen table uses one row per PO, with stage columns repeated
    // horizontally for easier spreadsheet-style scanning.
    const collapseStageLines = !!(data && data.filters && data.filters.collapseStageLines);

    return (data.rows || []).map((row, idx) => {
      const stages = buildDisplayStages(row).filter(stage => !shouldHideCollapsedDisplayStage(stage, collapseStageLines));

      return {
        poTone: String(idx % 8),
        poNumber: row.tranId || row.internalId || '',
        poInternalId: row.internalId || '',
        poUrl: row.url || '',
        vendor: row.vendor || '',
        createdDate: row.createdDate || '',
        prSubmissionDate: formatPrSubmissionDate(row),
        procurementApprovalDate: formatProcurementApprovalDate(row),
        poOrderDate: formatPoOrderDate(row),
        requestor: row.requestor || 'Unknown',
        amount: row.amount || 0,
        stages: stages.map(stage => ({
          stageNumber: formatStageNumber(stage.displaySeq || stage.seq || ''),
          approver: stage.approverText || '',
          stageStart: formatDateTimeText(stage.start, stage.startText),
          stageEnd: formatDateTimeText(stage.end, stage.endText),
          businessMinutes: Number(stage.businessMins || 0),
          businessTime: formatMinutes(stage.businessMins),
          calendarTime: formatMinutes(stage.calendarMins),
          currentStage: stage && stage.isCurrent ? 'Y' : ''
        }))
      };
    });
  }

  function buildDisplayStages(row) {
    // Display stages include the synthetic S0 Order Creator row before approval
    // stages, when the source data has an order creator.
    const stages = [];
    const orderCreatorStage = buildOrderCreatorDisplayStage(row);

    if (orderCreatorStage) stages.push(orderCreatorStage);
    return stages.concat(row && row.stages ? row.stages : []);
  }

  function buildOrderCreatorDisplayStage(row) {
    const orderCreator = clean(row && row.orderCreator);
    if (!orderCreator) return null;

    // S0 measures the order creator/requestor interval that happens before the
    // first approval stage. This is synthetic and not stored in the child record.
    const requestorTiming = row && row.requestorTiming;
    const createdDate = requestorTiming && requestorTiming.start
      ? requestorTiming.start
      : parseNsDateTime(row.createdDate);
    const firstApprovalStage = getFirstApprovalStage(row && row.stages);
    const firstApprovalStart = firstApprovalStage && firstApprovalStage.start ? firstApprovalStage.start : null;
    const hasApprovalStartAfterCreated = createdDate && firstApprovalStart && firstApprovalStart.getTime() > createdDate.getTime();
    const requestorEnd = requestorTiming && requestorTiming.end
      ? requestorTiming.end
      : hasApprovalStartAfterCreated ? firstApprovalStart : createdDate;
    const requestorEndText = requestorTiming && requestorTiming.endText
      ? requestorTiming.endText
      : hasApprovalStartAfterCreated
        ? firstApprovalStage.startText || formatDateTimeText(firstApprovalStart, '')
        : row.createdDate || '';
    const calendarMins = diffMinutes(createdDate, requestorEnd);
    const businessMins = requestorBusinessMinutesBetween(createdDate, requestorEnd, calendarMins);

    return {
      seq: 0,
      displaySeq: 'S0',
      approverText: orderCreator,
      role: 'Order Creator',
      start: createdDate,
      startText: requestorTiming && requestorTiming.startText ? requestorTiming.startText : row.createdDate || '',
      end: requestorEnd,
      endText: requestorEndText,
      calendarMins: calendarMins,
      businessMins: businessMins,
      waitMins: Math.max(0, calendarMins - businessMins),
      status: '',
      endReason: calendarMins > 0 ? 'Submit for Approval exited to first approval stage' : '',
      isCurrent: false,
      transitionType: 'Order Creator',
      slaBreached: false,
      isBottleneck: false
    };
  }

  function getFirstApprovalStage(stages) {
    // Stages should already be sorted, but selecting by earliest start protects
    // callers that pass fallback or partially reconstructed data.
    let firstStage = null;

    (stages || []).forEach(stage => {
      if (!stage || !stage.start) return;
      if (!firstStage || stage.start.getTime() < firstStage.start.getTime()) {
        firstStage = stage;
      }
    });

    return firstStage;
  }

  function requestorBusinessMinutesBetween(start, end, calendarMins) {
    // Requestor time is intentionally counted as elapsed calendar time. Business
    // hour filtering applies to approver stages, not the creator handoff.
    return Math.max(0, Number(calendarMins || 0));
  }

  function shouldHideCollapsedDisplayStage(stage, collapseStageLines) {
    if (!collapseStageLines || !stage) return false;
    if (stage.transitionType === 'Order Creator') return false;

    // Collapse mode keeps S0 and S1 visible and hides approval stages 2+.
    const seq = Number(stage.displaySeq || stage.seq || 0);
    return seq > 1;
  }

  function buildTimelineDisplayRow(row, stage, poTone, isPoStart) {
    // Flatten a PO/stage pair into plain display values so renderers do not need
    // to know about Date objects or raw stage fields.
    return {
      poTone: poTone || '0',
      isPoStart: !!isPoStart,
      showPoFields: !!isPoStart,
      approvalFlow: isPoStart ? buildApprovalFlowSummary(row.stages, row) : '',
      approvalFlowHtml: isPoStart ? buildApprovalFlowSummaryHtml(row.stages, row) : '',
      poNumber: row.tranId || row.internalId || '',
      poInternalId: row.internalId || '',
      poUrl: row.url || '',
      vendor: row.vendor || '',
      poDate: row.tranDate || '',
      prSubmissionDate: formatPrSubmissionDate(row),
      procurementApprovalDate: formatProcurementApprovalDate(row),
      poOrderDate: formatPoOrderDate(row),
      createdDate: row.createdDate || '',
      requestor: row.requestor || 'Unknown',
      approvalStatus: row.approvalStatus || '',
      transactionStatus: row.transactionStatus || '',
      amount: row.amount || 0,
      stageNumber: stage ? formatStageNumber(stage.displaySeq || stage.seq || '') : '',
      approver: stage ? stage.approverText || '' : '',
      role: stage ? stage.role || '' : '',
      stageStart: stage ? formatDateTimeText(stage.start, stage.startText) : '',
      stageEnd: stage ? formatDateTimeText(stage.end, stage.endText) : '',
      stageStatus: stage ? stage.status || '' : '',
      endReason: stage ? stage.endReason || '' : '',
      businessMinutes: stage ? Number(stage.businessMins || 0) : '',
      businessTime: stage ? formatMinutes(stage.businessMins) : '',
      calendarMinutes: stage ? Number(stage.calendarMins || 0) : '',
      calendarTime: stage ? formatMinutes(stage.calendarMins) : '',
      currentStage: stage && stage.isCurrent ? 'Y' : '',
      bottleneckStage: stage && stage.isBottleneck ? 'Y' : ''
    };
  }

  function formatPrSubmissionDate(row) {
    // Prefer the stored display text because NetSuite date formatting is account
    // and user-locale sensitive.
    const text = clean(row && row.prSubmissionDateText);
    if (text) return text;
    return row && row.prSubmissionDate ? formatDateTimeText(row.prSubmissionDate, '') : '';
  }

  function formatProcurementApprovalDate(row) {
    // Prefer the original workflow text, then format the parsed Date if needed.
    const text = clean(row && row.procurementApprovalDateText);
    if (text) return text;
    return row && row.procurementApprovalDate ? formatDateTimeText(row.procurementApprovalDate, '') : '';
  }

  function formatPoOrderDate(row) {
    // Prefer the source text so exported and on-screen values match NetSuite.
    const text = clean(row && row.poOrderDateText);
    if (text) return text;
    return row && row.poOrderDate ? formatDateTimeText(row.poOrderDate, '') : '';
  }

  function buildApprovalFlowSummary(stages, row) {
    // Plain-text approval flow is used where HTML chips are not appropriate.
    const parts = [];
    const orderCreator = clean(row && row.orderCreator);

    if (orderCreator) {
      const orderCreatorStage = buildOrderCreatorDisplayStage(row);
      const s0Minutes = orderCreatorStage ? Number(orderCreatorStage.businessMins || 0) : 0;
      const timeText = s0Minutes > 0 ? ' (' + formatMinutes(s0Minutes) + ')' : '';
      parts.push('S0: ' + orderCreator + timeText);
    }

    if (!stages || !stages.length) {
      return parts.length ? parts.join(' -> ') : 'No stages captured';
    }

    stages.forEach((stage, idx) => {
      const stageNum = stage.displaySeq || stage.seq || idx + 1;
      const approver = clean(stage.approverText) || 'Unknown';
      const minutes = Number(stage.businessMins || 0);
      const timeText = minutes > 0 ? ' (' + formatMinutes(minutes) + ')' : '';
      parts.push('S' + String(stageNum) + ': ' + approver + timeText);
    });

    if (shouldShowFlowEnd(row)) {
      parts.push('End');
    }

    return parts.join(' -> ');
  }

  function formatStageNumber(value) {
    // Normalize numeric and S-prefixed stage values into the user-facing label.
    const text = clean(value);
    if (!text) return '';
    const stageText = /^s/i.test(text) ? text.toUpperCase() : 'S' + text;
    return stageText;
  }

  function buildApprovalFlowSummaryHtml(stages, row) {
    // Chip-based approval flow mirrors the plain summary but carries visual state
    // for current and bottleneck stages.
    const orderCreator = clean(row && row.orderCreator);
    const flowParts = [];

    if (orderCreator) {
      const orderCreatorStage = buildOrderCreatorDisplayStage(row);
      const s0Minutes = orderCreatorStage ? Number(orderCreatorStage.businessMins || 0) : 0;
      const timeText = s0Minutes > 0 ? '(' + formatMinutes(s0Minutes) + ')' : '(0m)';
      flowParts.push('<span class="pa-flow-chip flow-tone-s0">' +
        '<span class="pa-flow-stage">S0:</span>' +
        '<span class="pa-flow-name">' + esc(orderCreator) + '</span>' +
        '<span class="pa-flow-time">' + esc(timeText) + '</span>' +
        '</span>' + ((stages && stages.length) || shouldShowFlowEnd(row) ? '<span class="pa-flow-step-arrow">-&gt;</span>' : ''));
    }

    if (!stages || !stages.length) {
      return flowParts.length
        ? '<div class="pa-flow-summary">' + flowParts.join('') + '</div>'
        : '<span class="pa-flow-empty">No stages captured</span>';
    }

    stages.forEach((stage, idx) => {
      const stageNum = stage.displaySeq || stage.seq || idx + 1;
      const approver = clean(stage.approverText) || 'Unknown';
      const minutes = Number(stage.businessMins || 0);
      const timeText = minutes > 0 ? '(' + formatMinutes(minutes) + ')' : '(0m)';
      const isLastVisibleStep = idx === stages.length - 1 && !shouldShowFlowEnd(row);
      const classes = [
        'pa-flow-chip',
        'flow-tone-' + String(idx % 6),
        stage.isCurrent ? 'current' : '',
        stage.isBottleneck ? 'bottleneck' : ''
      ].filter(Boolean).join(' ');
      const arrow = isLastVisibleStep ? '' : '<span class="pa-flow-step-arrow">-&gt;</span>';

      flowParts.push('<span class="' + escAttr(classes) + '">' +
        '<span class="pa-flow-stage">S' + esc(String(stageNum)) + ':</span>' +
        '<span class="pa-flow-name">' + esc(approver) + '</span>' +
        '<span class="pa-flow-time">' + esc(timeText) + '</span>' +
        '</span>' + arrow);
    });

    if (shouldShowFlowEnd(row)) {
      flowParts.push('<span class="pa-flow-chip end"><span class="pa-flow-stage">End</span></span>');
    }

    return '<div class="pa-flow-summary">' + flowParts.join('') + '</div>';
  }

  function shouldShowFlowEnd(row) {
    // Only approved POs get an explicit End marker; open POs end at the current
    // active approver or last captured stage.
    return !!row && isApprovedStatus(row.approvalStatus);
  }

  function buildTimelineTableHtml(rows) {
    // Determine the widest stage count on the page and repeat the stage columns so
    // every PO row has the same shape.
    const maxStageCount = Math.max(1, rows.reduce((max, row) => Math.max(max, row.stages.length), 0));
    const headers = [
      { label: 'PO #', className: 'pa-sticky-col pa-sticky-po' },
      { label: 'Vendor', className: 'pa-sticky-col pa-sticky-vendor' },
      { label: 'Created Date' },
      { label: 'PR Submission Date' },
      { label: 'Procurement Approval Date' },
      { label: 'PO Order Date' },
      { label: 'Requestor' },
      { label: 'Amount' }
    ];
    for (let i = 0; i < maxStageCount; i++) {
      headers.push.apply(headers, buildStageGroupHeaders(i));
    }

    return `
      <div class="pa-table-wrap">
        <table class="pa-table pa-table-wide" style="min-width:${escAttr(String(getTimelineTableWidth(maxStageCount)))}px">
          ${buildTimelineColumnGroup(maxStageCount)}
          <thead>
            <tr>
              ${headers.map(buildTimelineHeaderCellHtml).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => buildTimelineWideTableRowHtml(row, maxStageCount)).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function buildTimelineColumnGroup(stageCount) {
    // Fixed widths keep sticky columns and repeated stage groups aligned during
    // horizontal scrolling.
    const widths = [100, 190, 165, 165, 200, 165, 150, 90];
    for (let i = 0; i < stageCount; i++) {
      widths.push(100, 165, 155, 155, 120, 120);
    }

    return '<colgroup>' + widths.map(width => '<col style="width:' + escAttr(String(width)) + 'px" />').join('') + '</colgroup>';
  }

  function buildStageGroupHeaders(stageIndex) {
    return [
      { label: 'Stage #', className: 'pa-stage-group-start' },
      { label: Number(stageIndex || 0) === 0 ? 'Creator' : 'Approver' },
      { label: 'Stage Start' },
      { label: 'Stage End' },
      { label: 'Business Time' },
      { label: 'Calendar Time' }
    ];
  }

  function getTimelineTableWidth(stageCount) {
    // Base columns are about 1225px wide; each stage adds six more columns.
    return 1225 + (Number(stageCount || 1) * 815);
  }

  function buildTimelineHeaderCellHtml(header) {
    // Header objects can optionally carry sticky/group-start classes.
    const classAttr = header.className ? ' class="' + escAttr(header.className) + '"' : '';
    return '<th' + classAttr + '>' + esc(header.label) + '</th>';
  }

  function buildTimelineWideTableRowHtml(row, maxStageCount) {
    // Build all cells as strings first so blank stage groups can be padded to the
    // page maximum stage count.
    const poValue = row.poUrl
      ? '<a href="' + escAttr(row.poUrl) + '" target="_blank" rel="noopener">' + esc(row.poNumber) + '</a>'
      : esc(row.poNumber);
    const hasCurrentStage = (row.stages || []).some(stage => stage.currentStage);
    const rowClasses = [
      'pa-po-tone-' + (row.poTone || '0'),
      getTransactionNumberRowClass(row.poNumber),
      hasCurrentStage ? 'pa-current-row' : ''
    ].filter(Boolean).join(' ');
    const cells = [
      '<td class="pa-nowrap pa-strong pa-sticky-col pa-sticky-po">' + poValue + '</td>',
      '<td class="pa-sticky-col pa-sticky-vendor">' + esc(row.vendor) + '</td>',
      '<td class="pa-nowrap">' + esc(row.createdDate) + '</td>',
      '<td class="pa-nowrap">' + esc(row.prSubmissionDate) + '</td>',
      '<td class="pa-nowrap">' + esc(row.procurementApprovalDate) + '</td>',
      '<td class="pa-nowrap">' + esc(row.poOrderDate) + '</td>',
      '<td>' + esc(row.requestor) + '</td>',
      '<td class="pa-num">' + esc(formatCurrency(row.amount)) + '</td>'
    ];

    for (let i = 0; i < maxStageCount; i++) {
      const stage = row.stages[i];
      if (!stage) {
        // Empty stage columns preserve table alignment for POs with fewer stages.
        cells.push(
          '<td class="pa-stage-group-start"></td>',
          '<td></td>',
          '<td></td>',
          '<td></td>',
          '<td></td>',
          '<td></td>'
        );
        continue;
      }

      const isBusinessOverDay = Number(stage.businessMinutes || 0) >= 1440;
      // Long waits get a visual badge so the table can be scanned quickly.
      const businessTimeHtml = isBusinessOverDay
        ? '<span class="pa-time-badge over-day">' + esc(stage.businessTime) + '</span>'
        : esc(stage.businessTime);
      const businessTimeClass = isBusinessOverDay ? ' pa-business-over-day' : '';

      cells.push(
        '<td class="pa-nowrap pa-num pa-stage-group-start">' + esc(stage.stageNumber) + '</td>',
        '<td>' + esc(stage.approver) + '</td>',
        '<td class="pa-nowrap">' + esc(stage.stageStart) + '</td>',
        '<td class="pa-nowrap">' + esc(stage.stageEnd) + '</td>',
        '<td class="' + escAttr('pa-nowrap' + businessTimeClass) + '">' + businessTimeHtml + '</td>',
        '<td class="pa-nowrap">' + esc(stage.calendarTime) + '</td>'
      );
    }

    return '<tr class="' + escAttr(rowClasses) + '">' + cells.join('') + '</tr>';
  }

  function buildTimelineTableRowHtml(row) {
    // Older vertical table renderer retained as a fallback/reference for row-per-
    // stage layouts.
    const poValue = row.poUrl
      ? '<a href="' + escAttr(row.poUrl) + '" target="_blank" rel="noopener">' + esc(row.poNumber) + '</a>'
      : esc(row.poNumber);
    const showPoFields = !!row.showPoFields;
    const rowClasses = [
      'pa-po-tone-' + (row.poTone || '0'),
      getTransactionNumberRowClass(row.poNumber),
      row.isPoStart ? 'pa-po-start' : '',
      row.currentStage ? 'pa-current-row' : ''
    ].filter(Boolean).join(' ');
    const isBusinessOverDay = Number(row.businessMinutes || 0) >= 1440;
    const businessTimeHtml = isBusinessOverDay
      ? '<span class="pa-time-badge over-day">' + esc(row.businessTime) + '</span>'
      : esc(row.businessTime);
    const businessTimeClass = isBusinessOverDay ? ' pa-business-over-day' : '';

    return `
      <tr class="${escAttr(rowClasses)}">
        <td class="pa-nowrap pa-strong pa-sticky-col pa-sticky-po">${showPoFields ? poValue : ''}</td>
        <td class="pa-sticky-col pa-sticky-vendor">${showPoFields ? esc(row.vendor) : ''}</td>
        <td class="pa-nowrap">${showPoFields ? esc(row.poDate) : ''}</td>
        <td class="pa-nowrap">${showPoFields ? esc(row.prSubmissionDate) : ''}</td>
        <td class="pa-nowrap">${showPoFields ? esc(row.procurementApprovalDate) : ''}</td>
        <td class="pa-nowrap">${showPoFields ? esc(row.poOrderDate) : ''}</td>
        <td>${showPoFields ? esc(row.requestor) : ''}</td>
        <td class="pa-num">${showPoFields ? esc(formatCurrency(row.amount)) : ''}</td>
        <td class="pa-num">${esc(row.stageNumber)}</td>
        <td>${esc(row.approver)}</td>
        <td class="pa-nowrap">${esc(row.stageStart)}</td>
        <td class="pa-nowrap">${esc(row.stageEnd)}</td>
        <td class="${escAttr('pa-nowrap' + businessTimeClass)}">${businessTimeHtml}</td>
        <td class="pa-nowrap">${esc(row.calendarTime)}</td>
      </tr>`;
  }

  function buildStatusBadge(statusText) {
    // Status badges are currently used by card layouts and kept available for
    // future dashboard variants.
    const text = clean(statusText);
    if (!text) return '';

    return '<span class="pa-status-badge ' + escAttr(getStatusClass(text)) + '">' + esc(text) + '</span>';
  }

  function getTransactionNumberRowClass(transactionNumber) {
    const text = clean(transactionNumber).toUpperCase();

    if (text.indexOf('PR02') === 0) return 'pa-row-pr';
    if (text.indexOf('PO0') === 0) return 'pa-row-po';
    return '';
  }

  function getStatusClass(statusText) {
    // Classify by text fragments because NetSuite status labels vary by account
    // and transaction lifecycle.
    const status = clean(statusText).toLowerCase();

    if (!status) return 'status-neutral';
    if (status.indexOf('reject') >= 0 || status.indexOf('denied') >= 0 || status.indexOf('declined') >= 0) return 'status-rejected';
    if (status.indexOf('pending approval') >= 0 || status.indexOf('supervisor approval') >= 0 || status.indexOf('pending') >= 0) return 'status-pending';
    if (status.indexOf('approved') >= 0 || status.indexOf('pending receipt') >= 0 || status.indexOf('pending bill') >= 0 || status.indexOf('fully billed') >= 0 || status.indexOf('partially received') >= 0) return 'status-approved';
    if (status.indexOf('closed') >= 0 || status.indexOf('cancel') >= 0 || status.indexOf('void') >= 0) return 'status-closed';

    return 'status-neutral';
  }

  function buildPoCardHtml(row) {
    // Card layout is retained for alternate/mobile-style presentation, although
    // the current dashboard prefers the wide table.
    const flowHtml = row.stages.length ? buildFlowHtml(row.stages) : '<div class="pa-no-flow">No approval stages captured for this PO.</div>';
    const stageGridHtml = row.stages.length ? buildStageGridHtml(row) : '';
    const poTitle = row.url
      ? '<a href="' + escAttr(row.url) + '" target="_blank" rel="noopener">' + esc(row.tranId || row.internalId) + '</a>'
      : esc(row.tranId || row.internalId);

    return `
      <div class="pa-po-card">
        <div class="pa-po-head">
          <div class="pa-po-main">
            <div class="pa-po-title">${poTitle}</div>
            <div class="pa-po-vendor">${esc(row.vendor || 'No vendor')}</div>
          </div>
          <div class="pa-po-tags">
            <span class="pa-tag">Amount: ${esc(formatCurrency(row.amount))}</span>
            <span class="pa-tag">Approval: ${esc(row.approvalStatus || '-')}</span>
            <span class="pa-tag">Status: ${esc(row.transactionStatus || '-')}</span>
            <span class="pa-tag">PO Date: ${esc(row.tranDate || '-')}</span>
            <span class="pa-tag">Created: ${esc(row.createdDate || '-')}</span>
            <span class="pa-tag pa-tag-green">${esc(formatMinutes(row.totalBusinessMins))} business</span>
            <span class="pa-tag">${esc(formatMinutes(row.totalCalendarMins))} calendar</span>
            ${row.openStage ? '<span class="pa-tag pa-tag-amber">Current: ' + esc(row.openStage.approverText || 'Unknown') + '</span>' : ''}
          </div>
        </div>
        <div class="pa-flow-box">
          <div class="pa-flow-title">Approval Flow</div>
          ${flowHtml}
        </div>
        ${stageGridHtml}
      </div>`;
  }

  function buildFlowHtml(stages) {
    // Simple flow pills for the card layout.
    return `
      <div class="pa-flow">
        ${stages.map((stage, idx) => {
      const label = 'S' + String(idx + 1) + ': ' + (stage.approverText || 'Unknown');
      const arrow = idx < stages.length - 1 ? '<span class="pa-arrow">&rarr;</span>' : '';
      const cls = stage.isCurrent ? 'pa-flow-pill current' : stage.isBottleneck ? 'pa-flow-pill bottleneck' : 'pa-flow-pill';
      return '<span class="' + escAttr(cls) + '">' + esc(label) + '</span>' + arrow;
    }).join('')}
      </div>`;
  }

  function buildStageGridHtml(row) {
    // Requestor card plus one card per approval stage for the card layout.
    const requestorCard = `
      <div class="pa-stage-card requestor">
        <div class="pa-card-title">Requestor</div>
        <div class="pa-card-name">${esc(row.requestor || 'Unknown')}</div>
        <div class="pa-mini-tags">
          <span class="pa-mini-tag">PO Created: ${esc(row.createdDate || '-')}</span>
        </div>
      </div>`;

    const stageCards = row.stages.map((stage, idx) => buildStageCardHtml(stage, idx + 1)).join('');
    return `<div class="pa-stage-grid">${requestorCard}${stageCards}</div>`;
  }

  function buildStageCardHtml(stage, stageNum) {
    // Stage cards expose detail fields that are too verbose for the wide table.
    const classes = [
      'pa-stage-card',
      stage.isCurrent ? 'current' : '',
      stage.isBottleneck ? 'bottleneck' : '',
      stage.slaBreached ? 'sla' : ''
    ].join(' ');

    return `
      <div class="${escAttr(classes)}">
        <div class="pa-card-title">Approval Stage ${esc(String(stageNum))}</div>
        <div class="pa-card-name">${esc(stage.approverText || 'Unknown')}</div>
        <div class="pa-mini-tags">
          <span class="pa-mini-tag">${esc(stage.role || 'Role not captured')}</span>
          <span class="pa-mini-tag green">Business: ${esc(formatMinutes(stage.businessMins))}</span>
          <span class="pa-mini-tag">Calendar: ${esc(formatMinutes(stage.calendarMins))}</span>
          ${stage.slaBreached ? '<span class="pa-mini-tag red">SLA breached</span>' : ''}
          ${stage.isBottleneck ? '<span class="pa-mini-tag amber">Longest</span>' : ''}
        </div>
        <div class="pa-detail">Start: ${esc(formatDateTimeText(stage.start, stage.startText))}</div>
        <div class="pa-detail">End: ${esc(formatDateTimeText(stage.end, stage.endText))}</div>
        <div class="pa-detail">Status: ${esc(stage.status || '-')}</div>
        <div class="pa-detail">End reason: ${esc(stage.endReason || '-')}</div>
      </div>`;
  }

  function buildEmptyState(filters) {
    // Empty state still echoes the active date range so users can confirm which
    // filter produced no matches.
    return `
      <div class="pa-empty">
        <div class="pa-empty-title">No purchase orders found</div>
        <div>No POs matched the selected filters from ${esc(filters.dateFromText)} through ${esc(filters.dateToText)}.</div>
      </div>`;
  }

  function buildCss() {
    // Inline CSS keeps the Suitelet self-contained; no File Cabinet asset needs to
    // be deployed separately for the dashboard to render.
    return `
      <style>
        .pa-wrap{font-family:Arial,Helvetica,sans-serif;background:#f6f8fb;border:1px solid #dbe5f1;border-radius:6px;padding:14px;margin-top:8px;color:#182033}
        .pa-hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;background:linear-gradient(135deg,#ffffff 0%,#eef7f4 55%,#eef3fb 100%);border:1px solid #d7e4ef;border-radius:6px;padding:14px;margin-bottom:12px}
        .pa-title{font-size:20px;font-weight:800;color:#153f73;margin-bottom:4px}
        .pa-subtitle{font-size:12px;color:#5e6b80;line-height:1.4}
        .pa-hero-meta,.pa-po-tags,.pa-mini-tags{display:flex;flex-wrap:wrap;gap:7px}
        .pa-pill,.pa-tag,.pa-mini-tag{display:inline-block;border-radius:999px;background:#e8eefb;color:#214e98;font-weight:700;font-size:12px;line-height:1.2;padding:7px 11px}
        .pa-pill-green,.pa-tag-green,.pa-mini-tag.green{background:#e4f5e8;color:#0a7a43}
        .pa-pill-amber,.pa-tag-amber,.pa-mini-tag.amber{background:#fff0d8;color:#955300}
        .pa-mini-tag.red{background:#ffe8e8;color:#b42318}
        .pa-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-bottom:14px}
        .pa-kpi{background:#fff;border:1px solid #dce4ef;border-left:4px solid #477bb8;border-radius:6px;padding:11px;min-width:0}
        .pa-kpi.tone-teal{border-left-color:#139f91}.pa-kpi.tone-green{border-left-color:#16a34a}.pa-kpi.tone-slate{border-left-color:#64748b}.pa-kpi.tone-amber{border-left-color:#d9981e}.pa-kpi.tone-orange{border-left-color:#f97316}
        .pa-kpi-label{font-size:11px;text-transform:uppercase;color:#65748a;font-weight:800;letter-spacing:.02em}
        .pa-kpi-value{font-size:19px;font-weight:800;color:#172033;margin:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .pa-kpi-sub{font-size:12px;color:#63708a;line-height:1.3}
        .pa-section-head{display:flex;align-items:flex-end;justify-content:space-between;margin:6px 0 10px}
        .pa-section-title{font-size:16px;font-weight:800;color:#153f73}
        .pa-section-subtitle,.pa-count{font-size:12px;color:#63708a;font-weight:700}
        .pa-pager{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 0 10px;padding:8px 10px;background:#fff;border:1px solid #d9e1ef;border-radius:6px}
        .pa-page-status{font-size:12px;color:#52627a;font-weight:800}
        .pa-page-actions{display:flex;gap:8px;align-items:center}
        .pa-page-btn{display:inline-block;border:1px solid #477bb8;background:#477bb8;color:#fff;border-radius:4px;padding:6px 10px;font-size:12px;font-weight:800;text-decoration:none}
        .pa-page-btn:hover{background:#37669c;text-decoration:none}
        .pa-page-btn.disabled{background:#edf2f7;border-color:#d7e0ec;color:#8a97aa;cursor:default}
        .pa-footer-meta{display:flex;justify-content:center;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0 2px;padding-top:12px;border-top:1px solid #d9e1ef}
        .pa-table-wrap{background:#fff;border:1px solid #d9e1ef;border-radius:6px;overflow:auto;max-height:640px}
        .pa-table{width:100%;min-width:1820px;border-collapse:separate;border-spacing:0;font-size:12px;color:#172033}
        .pa-table th{position:sticky;top:0;z-index:2;background:#5f789d;color:#fff;text-align:left;font-weight:800;padding:8px 9px;border-right:1px solid rgba(255,255,255,.28);white-space:nowrap;box-sizing:border-box}
        .pa-table td{padding:7px 9px;border-top:1px solid #e5edf6;border-right:1px solid #edf2f7;vertical-align:top;line-height:1.3;box-sizing:border-box}
        .pa-table .pa-sticky-col{position:sticky;background:inherit}
        .pa-table th.pa-sticky-col{z-index:5;background:#5f789d}
        .pa-table td.pa-sticky-col{z-index:3}
        .pa-table .pa-sticky-po{left:0;width:100px;min-width:100px;max-width:100px}
        .pa-table .pa-sticky-vendor{left:100px;width:190px;min-width:190px;max-width:190px;box-shadow:3px 0 6px rgba(15,23,42,.08)}
        .pa-table tbody tr:nth-child(even){background:#f8fafc}
        .pa-table tbody tr.pa-po-tone-0{background:#ffffff}
        .pa-table tbody tr.pa-po-tone-1{background:#eef6ff}
        .pa-table tbody tr.pa-po-tone-2{background:#f0fdf4}
        .pa-table tbody tr.pa-po-tone-3{background:#fff7ed}
        .pa-table tbody tr.pa-po-tone-4{background:#f5f3ff}
        .pa-table tbody tr.pa-po-tone-5{background:#f0fdfa}
        .pa-table tbody tr.pa-po-tone-6{background:#fff1f2}
        .pa-table tbody tr.pa-po-tone-7{background:#f8fafc}
        .pa-table tbody tr.pa-po-tone-0 td:first-child{border-left:4px solid #477bb8}
        .pa-table tbody tr.pa-po-tone-1 td:first-child{border-left:4px solid #2563eb}
        .pa-table tbody tr.pa-po-tone-2 td:first-child{border-left:4px solid #16a34a}
        .pa-table tbody tr.pa-po-tone-3 td:first-child{border-left:4px solid #ea580c}
        .pa-table tbody tr.pa-po-tone-4 td:first-child{border-left:4px solid #7c3aed}
        .pa-table tbody tr.pa-po-tone-5 td:first-child{border-left:4px solid #0f766e}
        .pa-table tbody tr.pa-po-tone-6 td:first-child{border-left:4px solid #be123c}
        .pa-table tbody tr.pa-po-tone-7 td:first-child{border-left:4px solid #64748b}
        .pa-table tbody tr.pa-po-start td{border-top:3px solid #8aa6cc}
        .pa-table tbody tr.pa-po-start td:first-child{font-size:13px}
        .pa-table tbody tr.pa-current-row{background:#dff4ff}
        .pa-table tbody tr.pa-current-row td{border-top-color:#a7d8f5;border-bottom:1px solid #a7d8f5}
        .pa-table tbody tr.pa-current-row td.pa-sticky-col{background:#dff4ff}
        .pa-table tbody tr.pa-row-pr{background:#fff3c4}
        .pa-table tbody tr.pa-row-pr td.pa-sticky-col{background:#fff3c4}
        .pa-table tbody tr.pa-row-pr td:first-child{border-left:4px solid #d97706}
        .pa-table tbody tr.pa-row-po{background:#dcfce7}
        .pa-table tbody tr.pa-row-po td.pa-sticky-col{background:#dcfce7}
        .pa-table tbody tr.pa-row-po td:first-child{border-left:4px solid #16a34a}
        .pa-table tbody tr:hover{background:#eef6ff}
        .pa-table tbody tr:hover td.pa-sticky-col{background:#eef6ff}
        .pa-table tbody tr.pa-current-row:hover{background:#d7ecff}
        .pa-table tbody tr.pa-current-row:hover td.pa-sticky-col{background:#d7ecff}
        .pa-table tbody tr.pa-row-pr:hover{background:#ffe8a3}
        .pa-table tbody tr.pa-row-pr:hover td.pa-sticky-col{background:#ffe8a3}
        .pa-table tbody tr.pa-row-po:hover{background:#bbf7d0}
        .pa-table tbody tr.pa-row-po:hover td.pa-sticky-col{background:#bbf7d0}
        .pa-table a{color:#153f73;font-weight:800;text-decoration:none}
        .pa-table a:hover{text-decoration:underline}
        .pa-table th.pa-stage-group-start,.pa-table td.pa-stage-group-start{border-left:3px solid #8aa6cc}
        .pa-table td.pa-business-over-day{background:#fff7ed;color:#955300;font-weight:800;box-shadow:inset 4px 0 0 #d9981e}
        .pa-time-badge{display:inline-block;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:900;line-height:1.2;white-space:nowrap}
        .pa-time-badge.over-day{background:linear-gradient(135deg,#ffedd5 0%,#fed7aa 55%,#fff7ed 100%);border:1px solid #fb923c;color:#9a3412}
        .pa-flow-summary-cell{min-width:360px;max-width:520px}
        .pa-flow-summary{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
        .pa-flow-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:5px 8px;font-size:11px;font-weight:800;line-height:1.1;border:1px solid transparent;white-space:nowrap}
        .pa-flow-chip.flow-tone-s0{background:linear-gradient(135deg,#f8fafc 0%,#e2e8f0 55%,#f1f5f9 100%);color:#334155;border-color:#cbd5e1}
        .pa-flow-chip.flow-tone-0{background:linear-gradient(135deg,#eaf2ff 0%,#dbeafe 55%,#eef6ff 100%);color:#1d4f91;border-color:#bfd7ff}
        .pa-flow-chip.flow-tone-1{background:linear-gradient(135deg,#e0f7ff 0%,#bae6fd 55%,#ecfeff 100%);color:#03667d;border-color:#67e8f9}
        .pa-flow-chip.flow-tone-2{background:linear-gradient(135deg,#fff7ed 0%,#fed7aa 58%,#fff1e6 100%);color:#9a3412;border-color:#fdba74}
        .pa-flow-chip.flow-tone-3{background:linear-gradient(135deg,#f5f3ff 0%,#ddd6fe 56%,#eef2ff 100%);color:#6d28d9;border-color:#c4b5fd}
        .pa-flow-chip.flow-tone-4{background:linear-gradient(135deg,#ecfeff 0%,#bae6fd 52%,#eef2ff 100%);color:#075985;border-color:#7dd3fc}
        .pa-flow-chip.flow-tone-5{background:linear-gradient(135deg,#f0fdfa 0%,#99f6e4 55%,#ecfeff 100%);color:#0f766e;border-color:#5eead4}
        .pa-flow-chip.current{background:linear-gradient(135deg,#dbeafe 0%,#bfdbfe 55%,#e0f2fe 100%);color:#1e40af;border-color:#60a5fa;box-shadow:0 0 0 2px rgba(59,130,246,.18)}
        .pa-flow-chip.bottleneck{border-color:#a855f7}
        .pa-flow-chip.end{background:linear-gradient(135deg,#bbf7d0 0%,#86efac 55%,#dcfce7 100%);color:#14532d;border-color:#22c55e;box-shadow:inset 0 0 0 1px rgba(20,83,45,.12)}
        .pa-flow-stage{font-weight:900}
        .pa-flow-time{font-weight:800;opacity:.78}
        .pa-flow-step-arrow{color:#64748b;font-weight:900;font-size:11px}
        .pa-flow-empty{color:#64748b;font-weight:800}
        .pa-num{text-align:right;white-space:nowrap}
        .pa-flag{text-align:center;font-weight:800;color:#0a7a43}
        .pa-nowrap{white-space:nowrap}
        .pa-strong{font-weight:800}
        .pa-status-badge{display:inline-block;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:800;line-height:1.2;white-space:nowrap}
        .pa-status-badge.status-approved{background:#dcfce7;color:#166534}
        .pa-status-badge.status-pending{background:#fef3c7;color:#92400e}
        .pa-status-badge.status-rejected{background:#fee2e2;color:#991b1b}
        .pa-status-badge.status-closed{background:#e5e7eb;color:#374151}
        .pa-status-badge.status-current{background:#dbeafe;color:#1e40af}
        .pa-status-badge.status-bottleneck{background:#ede9fe;color:#6d28d9}
        .pa-status-badge.status-neutral{background:#e8eefb;color:#214e98}
        .pa-po-list{display:flex;flex-direction:column;gap:12px}
        .pa-po-card{background:#fff;border:1px solid #d9e1ef;border-radius:6px;padding:14px;box-shadow:0 1px 3px rgba(15,23,42,.04)}
        .pa-po-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:10px}
        .pa-po-main{min-width:180px}
        .pa-po-title{font-size:16px;font-weight:800;color:#153f73;line-height:1.2}
        .pa-po-title a{color:#153f73;text-decoration:none}.pa-po-title a:hover{text-decoration:underline}
        .pa-po-vendor{font-size:13px;color:#4d5b70;margin-top:3px}
        .pa-flow-box{border:1px solid #d9e5f4;background:#fbfdff;border-radius:6px;padding:11px 12px;margin-top:8px}
        .pa-flow-title,.pa-card-title{font-size:12px;color:#164a91;font-weight:800;margin-bottom:8px}
        .pa-flow{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
        .pa-flow-pill{background:#2f6fb3;color:#fff;border-radius:999px;padding:9px 13px;font-size:12px;font-weight:800}
        .pa-flow-pill.current{background:#d99016}.pa-flow-pill.bottleneck{background:#8a56cc}
        .pa-arrow{color:#5c6c84;font-weight:800}
        .pa-no-flow{color:#63708a;font-size:12px;font-weight:700}
        .pa-stage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
        .pa-stage-card{background:#fff;border:1px solid #d8e1ef;border-radius:6px;padding:12px;min-width:0;position:relative}
        .pa-stage-card:before{content:'';position:absolute;top:0;left:14px;right:14px;height:3px;background:#ced9eb;border-radius:0 0 5px 5px}
        .pa-stage-card.requestor{background:#f9fbff;border-color:#c9d8f2}.pa-stage-card.requestor:before{background:#5b88c7}
        .pa-stage-card.current:before,.pa-stage-card.bottleneck:before{background:#d99016}
        .pa-stage-card.sla:before{background:#d14d4d}
        .pa-card-name{font-size:14px;font-weight:800;color:#172033;margin-bottom:10px;word-break:break-word}
        .pa-mini-tag{font-size:11px;padding:6px 10px}
        .pa-detail{font-size:12px;color:#5f6f86;line-height:1.35;margin-top:6px;word-break:break-word}
        .pa-empty{background:#fff;border:1px dashed #c6d3e5;border-radius:6px;padding:18px;color:#63708a}
        .pa-empty-title{font-size:14px;font-weight:800;color:#153f73;margin-bottom:4px}
        @media(max-width:1250px){.pa-kpis{grid-template-columns:repeat(3,minmax(0,1fr))}.pa-stage-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pa-po-head,.pa-hero{flex-direction:column}}
        @media(max-width:760px){.pa-kpis,.pa-stage-grid{grid-template-columns:1fr}.pa-po-tags,.pa-hero-meta{align-items:flex-start}.pa-kpi-value{white-space:normal}}
      </style>`;
  }

  function writeCsv(response, data) {
    // CSV export uses the row-per-stage shape so downstream spreadsheet users can
    // filter/sort stages independently.
    const rows = [];

    rows.push(['PO Approval Timeline - Last 30 Days']);
    rows.push(['PO Date From', data.filters.dateFromText]);
    rows.push(['PO Date To', data.filters.dateToText]);
    rows.push(['Search', data.filters.searchText || '']);
    rows.push(['Hide Stage Lines 2+', data.filters.collapseStageLines ? 'Yes' : 'No']);
    rows.push([]);
    rows.push([
      'PO #',
      'PO Internal ID',
      'Vendor',
      'Created Date',
      'PR Submission Date',
      'Procurement Approval Date',
      'PO Order Date',
      'Requestor',
      'Amount',
      'Stage #',
      'Approver',
      'Stage Start',
      'Stage End',
      'Business Time',
      'Calendar Time',
      'Business Minutes',
      'Calendar Minutes'
    ]);

    data.rows.forEach(row => {
      const displayStages = buildDisplayStages(row);

      if (!displayStages.length) {
        // Keep one row for POs without timeline stages so the export matches the
        // visible PO list.
        rows.push(buildCsvStageRow(row, null, true));
        return;
      }

      displayStages.forEach((stage, idx) => {
        if (shouldHideCollapsedDisplayStage(stage, data.filters.collapseStageLines)) return;
        rows.push(buildCsvStageRow(row, stage, idx === 0));
      });
    });

    response.addHeader({
      name: 'Content-Type',
      value: 'text/csv; charset=utf-8'
    });
    response.addHeader({
      name: 'Content-Disposition',
      value: 'attachment; filename="PO_Approval_Timeline_Last_30_Days.csv"'
    });
    response.write(rows.map(toCsvRow).join('\n'));
  }

  function writeExcel(response, data) {
    // NetSuite can stream an HTML document as an .xls file; Excel opens the styled
    // table while avoiding external spreadsheet libraries.
    const workbook = buildExcelHtml(data);
    const excelFile = file.create({
      name: 'PO_Approval_Timeline_Last_30_Days.xls',
      fileType: file.Type.HTMLDOC,
      contents: workbook
    });

    response.writeFile({
      file: excelFile,
      isInline: false
    });
  }

  function buildExcelHtml(data) {
    // Excel-specific markup keeps the first row frozen and preserves basic number
    // and datetime formatting in the downloaded workbook.
    return [
      '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">',
      '<head>',
      '<meta http-equiv="Content-Type" content="application/vnd.ms-excel; charset=utf-8" />',
      '<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>PO Timeline</x:Name><x:WorksheetOptions><x:FreezePanes/><x:FrozenNoSplit/><x:SplitHorizontal>1</x:SplitHorizontal><x:TopRowBottomPane>1</x:TopRowBottomPane><x:ActivePane>2</x:ActivePane></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->',
      '<style>',
      'body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#172033;margin:0}',
      'table.timeline{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}',
      'th{background:#5f789d;color:#ffffff;font-weight:bold;border:1px solid #c8d6ea;padding:7px 9px;white-space:nowrap;text-align:left}',
      'td{border:1px solid #e5edf6;padding:6px 9px;vertical-align:top;white-space:nowrap}',
      'tr.tone-0 td{background:#fff7ed}',
      'tr.tone-1 td{background:#f5f3ff}',
      'tr.tone-2 td{background:#eef6ff}',
      'tr.tone-3 td{background:#f0fdf4}',
      'tr.tone-4 td{background:#fff1f2}',
      'tr.tone-5 td{background:#f0fdfa}',
      'tr.tone-6 td{background:#f8fafc}',
      'tr.tone-7 td{background:#ffffff}',
      '.po-number{font-weight:bold;color:#153f73;mso-number-format:"\\@"}',
      '.number{text-align:right;mso-number-format:"#,##0.00"}',
      '.date{mso-number-format:"m\\/d\\/yy"}',
      '.datetime{mso-number-format:"m\\/d\\/yy h:mm AM\\/PM"}',
      '.time-text{mso-number-format:"\\@"}',
      '.nowrap{white-space:nowrap}',
      '</style>',
      '</head>',
      '<body>',
      buildExcelTimelineHtml(data),
      '</body></html>'
    ].join('');
  }

  function buildExcelSummaryHtml(data) {
    // Summary table is retained for possible workbook expansion; the current
    // export writes the timeline sheet only.
    const summary = data.summary;
    const longestPo = summary.longestPo;
    const longestStage = summary.longestStage;
    const rows = [
      ['PO Date From', data.filters.dateFromText],
      ['PO Date To', data.filters.dateToText],
      ['Search', data.filters.searchText || ''],
      ['Hide Stage Lines 2+', data.filters.collapseStageLines ? 'Yes' : 'No'],
      ['PO Count', summary.poCount],
      ['Approved Count', summary.approvedCount],
      ['Open / Non-Approved Count', summary.openCount],
      ['Missing Timeline Count', summary.noTimelineCount],
      ['Total Amount', formatCurrency(summary.amountTotal)],
      ['Average Business Time', formatMinutes(summary.avgBusinessMins)],
      ['Average Calendar Time', formatMinutes(summary.avgCalendarMins)],
      ['Longest PO', longestPo && longestPo.totalBusinessMins > 0 ? longestPo.tranId : ''],
      ['Longest PO Business Time', longestPo && longestPo.totalBusinessMins > 0 ? formatMinutes(longestPo.totalBusinessMins) : ''],
      ['Longest Stage', longestStage ? longestStage.po.tranId + ' ' + formatStageNumber(longestStage.stage.displaySeq || longestStage.stage.seq || '') : ''],
      ['Longest Stage Approver', longestStage ? longestStage.stage.approverText : ''],
      ['Longest Stage Business Time', longestStage ? formatMinutes(longestStage.stage.businessMins) : '']
    ];

    return '<table>' + rows.map(row => '<tr><td class="label">' + esc(row[0]) + '</td><td>' + esc(row[1]) + '</td></tr>').join('') + '</table>';
  }

  function buildExcelTimelineHtml(data) {
    // Excel export mirrors the wide on-screen table: one PO row with repeated
    // stage groups across the sheet.
    const collapseStageLines = !!(data && data.filters && data.filters.collapseStageLines);
    const rows = buildExcelWideRows(data.rows || [], collapseStageLines);
    const maxStageCount = Math.max(1, rows.reduce((max, row) => Math.max(max, row.stages.length), 0));
    const headers = [
      'PO #',
      'Vendor',
      'Created Date',
      'PR Submission Date',
      'Procurement Approval Date',
      'PO Order Date',
      'Requestor',
      'Amount'
    ];
    for (let i = 0; i < maxStageCount; i++) {
      headers.push.apply(headers, buildExcelStageGroupHeaders(i));
    }

    const body = rows.map((row, idx) => {
      // Cell objects can carry Excel CSS classes, while plain values use the
      // default text cell behavior.
      const cells = [
        { value: row.poNumber, className: 'po-number' },
        row.vendor,
        { value: row.createdDate, className: 'datetime' },
        { value: row.prSubmissionDate, className: 'datetime' },
        { value: row.procurementApprovalDate, className: 'datetime' },
        { value: row.poOrderDate, className: 'datetime' },
        row.requestor,
        { value: row.amount, className: 'number' }
      ];

      for (let i = 0; i < maxStageCount; i++) {
        const stage = row.stages[i];
        cells.push(
          stage ? stage.stageNumber : '',
          stage ? stage.approver : '',
          { value: stage ? stage.stageStart : '', className: 'datetime' },
          { value: stage ? stage.stageEnd : '', className: 'datetime' },
          { value: stage ? stage.businessTime : '', className: 'time-text' },
          { value: stage ? stage.calendarTime : '', className: 'time-text' }
        );
      }

      return '<tr class="tone-' + escAttr(String(idx % 8)) + '">' + cells.map(buildExcelHtmlCell).join('') + '</tr>';
    }).join('');

    return '<table class="timeline">' + buildExcelColumnGroup(maxStageCount) + '<thead><tr>' + headers.map(header => '<th>' + esc(header) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function buildExcelWideRows(rows, collapseStageLines) {
    // Convert summary rows into a display-only shape before writing Excel markup.
    return (rows || []).map(row => {
      const stages = buildDisplayStages(row).filter(stage => !shouldHideCollapsedDisplayStage(stage, collapseStageLines));

      return {
        poNumber: row.tranId || row.internalId || '',
        vendor: row.vendor || '',
        createdDate: row.createdDate || '',
        prSubmissionDate: formatPrSubmissionDate(row),
        procurementApprovalDate: formatProcurementApprovalDate(row),
        poOrderDate: formatPoOrderDate(row),
        requestor: row.requestor || 'Unknown',
        amount: row.amount || 0,
        stages: stages.map(stage => ({
          stageNumber: formatStageNumber(stage.displaySeq || stage.seq || ''),
          approver: stage.approverText || '',
          stageStart: formatDateTimeText(stage.start, stage.startText),
          stageEnd: formatDateTimeText(stage.end, stage.endText),
          businessTime: formatMinutes(stage.businessMins),
          calendarTime: formatMinutes(stage.calendarMins)
        }))
      };
    });
  }

  function buildExcelColumnGroup(stageCount) {
    // Match Excel column widths to the on-screen wide table as closely as HTML
    // table rendering allows.
    const widths = [95, 200, 165, 165, 205, 165, 150, 95];
    for (let i = 0; i < stageCount; i++) {
      widths.push(100, 165, 155, 155, 120, 120);
    }

    return '<colgroup>' + widths.map(width => '<col style="width:' + escAttr(String(width)) + 'px" />').join('') + '</colgroup>';
  }

  function buildExcelStageGroupHeaders(stageIndex) {
    return [
      'Stage #',
      Number(stageIndex || 0) === 0 ? 'Creator' : 'Approver',
      'Stage Start',
      'Stage End',
      'Business Time',
      'Calendar Time'
    ];
  }

  function buildExcelHtmlCell(cell) {
    // Accept either primitive values or { value, className } descriptors.
    const cellObj = (cell && typeof cell === 'object' && Object.prototype.hasOwnProperty.call(cell, 'value')) ? cell : { value: cell };
    const classAttr = cellObj.className ? ' class="' + escAttr(cellObj.className) + '"' : '';
    return '<td' + classAttr + '>' + esc(cellObj.value) + '</td>';
  }

  function buildCsvStageRow(row, stage, isPoStart) {
    // isPoStart is retained for compatibility with prior row-builder signatures;
    // the CSV now repeats PO fields on every row for easier filtering.
    return [
      row.tranId,
      row.internalId,
      row.vendor,
      row.createdDate,
      formatPrSubmissionDate(row),
      formatProcurementApprovalDate(row),
      formatPoOrderDate(row),
      row.requestor,
      formatCurrency(row.amount),
      stage ? formatStageNumber(stage.displaySeq || stage.seq || '') : '',
      stage ? stage.approverText : '',
      stage ? formatDateTimeText(stage.start, stage.startText) : '',
      stage ? formatDateTimeText(stage.end, stage.endText) : '',
      stage ? formatMinutes(stage.businessMins) : '',
      stage ? formatMinutes(stage.calendarMins) : '',
      stage ? Number(stage.businessMins || 0) : '',
      stage ? Number(stage.calendarMins || 0) : ''
    ];
  }

  function writeErrorPage(response, e) {
    // Render errors inside a normal NetSuite form so users can capture the failure
    // message and support can still identify the Suitelet.
    const form = serverWidget.createForm({ title: CONFIG.title });
    const html = form.addField({
      id: 'custpage_error',
      type: serverWidget.FieldType.INLINEHTML,
      label: 'Error'
    });

    html.defaultValue =
      '<div style="border:1px solid #efb4b4;background:#fff7f7;color:#9f1d1d;padding:14px;margin-top:12px;font-weight:700;">' +
      esc(describeError(e)) +
      '</div>';
    response.writePage(form);
  }

  function normalizeFilters(params) {
    // Accept both NetSuite field IDs and shorter alias params so links/tests can
    // call the Suitelet without duplicating UI field names.
    const defaults = getDefaultDateRange();
    const dateFrom = stripTime(parseDateParam(params.custpage_datefrom || params.dateFrom || params.from) || defaults.dateFrom);
    const dateTo = stripTime(parseDateParam(params.custpage_dateto || params.dateTo || params.to) || defaults.dateTo);
    const normalized = dateFrom.getTime() <= dateTo.getTime()
      ? { dateFrom: dateFrom, dateTo: dateTo }
      : { dateFrom: dateTo, dateTo: dateFrom };

    // Swap reversed dates instead of erroring; this keeps accidental date entry
    // mistakes from breaking the report.
    return {
      dateFrom: normalized.dateFrom,
      dateTo: normalized.dateTo,
      dateFromText: formatDate(normalized.dateFrom),
      dateToText: formatDate(normalized.dateTo),
      searchText: clean(params.custpage_search || params.search || ''),
      timelineOnly: toBool(params.custpage_timelineonly || params.timelineOnly),
      collapseStageLines: toBool(params.custpage_collapsestagelines || params.collapseStageLines),
      pageIndex: Math.max(0, toInteger(params.custpage_page || params.page || 0))
    };
  }

  function getDefaultDateRange() {
    // Default window is inclusive from today minus CONFIG.defaultDaysBack through
    // today, with times stripped for stable NetSuite date filters.
    const today = stripTime(new Date());
    return {
      dateFrom: addDays(today, -CONFIG.defaultDaysBack),
      dateTo: today
    };
  }

  function filterRowsBySearch(rows, searchText) {
    const needle = clean(searchText).toLowerCase();
    if (!needle) return rows;

    return rows.filter(row => {
      // Search the enriched row, not just transaction fields, so fallback approver
      // names and workflow milestone text are searchable.
      const parts = [
        row.tranId,
        row.vendor,
        row.requestor,
        row.procurementApprovalDateText,
        row.approvalStatus,
        row.transactionStatus
      ];

      row.stages.forEach(stage => {
        parts.push(stage.approverText, stage.role, stage.status);
      });

      return parts.join(' ').toLowerCase().indexOf(needle) >= 0;
    });
  }

  function shouldApplyTranIdSearch(searchText) {
    // Only apply a transaction search filter for PO-like values. Broad free-text
    // search remains a post-load filter.
    const text = clean(searchText).toUpperCase().replace(/\s+/g, '');
    return /^P[OR][0-9]{3,}$/.test(text) || /^[0-9]{4,}$/.test(text);
  }

  function isRelevantSystemNoteField(fieldName) {
    // System Notes fallback only needs fields that can start/end approval stages.
    const normalized = normalizeFieldName(fieldName);
    return isDocStatusField(normalized) ||
      isNextApproverField(normalized) ||
      isNextApproverRoleField(normalized);
  }

  function isDocStatusField(normalizedField) {
    // Document status fields close final stages when approval completes.
    return normalizedField === 'documentstatus' ||
      normalizedField === 'approvalstatus' ||
      normalizedField === 'orderstatus' ||
      normalizedField.indexOf('documentstatus') >= 0;
  }

  function isNextApproverField(normalizedField) {
    // Avoid treating next approver role as the approver person field.
    if (isNextApproverRoleField(normalizedField)) return false;
    return normalizedField === 'nextapprover' ||
      normalizedField === 'custbodynextapprover' ||
      normalizedField.indexOf('nextapprover') >= 0;
  }

  function isNextApproverRoleField(normalizedField) {
    // Role fields describe the approver stage but do not identify the employee.
    return normalizedField === 'nextapproverrole' ||
      normalizedField === 'custbodynextapproverrole' ||
      normalizedField.indexOf('nextapproverrole') >= 0;
  }

  function collectSystemNoteApproverIds(eventsByPo) {
    // Collect employee internal IDs from System Notes so fallback stages can show
    // names instead of numeric IDs.
    const seen = {};
    const ids = [];

    Object.keys(eventsByPo || {}).forEach(poId => {
      (eventsByPo[poId] || []).forEach(event => {
        if (!isNextApproverField(normalizeFieldName(event.field))) return;

        const id = normalizeEmployeeId(event.newValue);
        if (!id || seen[id]) return;

        seen[id] = true;
        ids.push(id);
      });
    });

    return ids;
  }

  function getEmployeeNameMap(employeeIds) {
    // Resolve employee display names in one search rather than one lookup per
    // System Note event.
    const ids = uniqueTruthy(employeeIds);
    const map = {};
    if (!ids.length) return map;

    try {
      const empSearch = search.create({
        type: search.Type.EMPLOYEE,
        filters: [['internalid', 'anyof', ids]],
        columns: [
          search.createColumn({ name: 'internalid' }),
          search.createColumn({ name: 'entityid' }),
          search.createColumn({ name: 'firstname' }),
          search.createColumn({ name: 'lastname' })
        ]
      });

      runPaged(empSearch, result => {
        const id = String(result.getValue('internalid') || '');
        const entityId = result.getValue('entityid') || '';
        const firstName = result.getValue('firstname') || '';
        const lastName = result.getValue('lastname') || '';
        const fullName = clean(firstName + ' ' + lastName) || entityId || id;

        if (id) map[id] = fullName;
      });
    } catch (e) {
      log.error({
        title: 'PO approval employee lookup failed',
        details: describeError(e)
      });
    }

    return map;
  }

  function resolveSystemNoteApproverName(rawValue, employeeMap) {
    // System Notes may store either an employee ID or already-readable text.
    const rawText = normalizeApproverDisplay(rawValue);
    if (!rawText) return '';

    const employeeId = normalizeEmployeeId(rawText);
    if (employeeId && employeeMap && employeeMap[employeeId]) return employeeMap[employeeId];
    return rawText || 'Unknown';
  }

  function normalizeEmployeeId(value) {
    // Employee IDs are numeric in System Notes. Anything else is treated as text.
    const text = clean(value);
    return /^\d+$/.test(text) ? text : '';
  }

  function normalizeApproverDisplay(value) {
    // NetSuite sometimes represents empty list values as -1/none/null text.
    const text = clean(value);
    const normalized = text.toLowerCase();

    if (!text || normalized === '-1' || normalized === 'none' || normalized === 'null') {
      return '';
    }

    return text;
  }

  function normalizeApproverKey(value) {
    // Lowercased approver key for duplicate/coverage comparisons.
    return normalizeApproverDisplay(value).toLowerCase();
  }

  function sameCleanText(a, b) {
    // Case-insensitive comparison after the same cleanup path used everywhere else.
    return clean(a).toLowerCase() === clean(b).toLowerCase();
  }

  function getSearchableTransactionColumnIds(fieldIds) {
    // Drop unavailable field IDs before building transaction searches.
    return uniqueTruthy(fieldIds).filter(fieldId => hasTransactionColumn(fieldId));
  }

  function hasTransactionColumn(fieldId) {
    const key = clean(fieldId);
    if (!key) return false;

    if (Object.prototype.hasOwnProperty.call(STATE.transactionColumnCache, key)) {
      return STATE.transactionColumnCache[key];
    }

    let exists = false;
    try {
      // No-result search acts as a schema/permission probe for the candidate
      // transaction column.
      search.create({
        type: search.Type.TRANSACTION,
        filters: [['internalid', 'anyof', '@NONE@']],
        columns: [search.createColumn({ name: key })]
      }).run().getRange({ start: 0, end: 1 });
      exists = true;
    } catch (e) {
      exists = false;
    }

    STATE.transactionColumnCache[key] = exists;
    return exists;
  }

  function readFirstResultColumnText(result, fieldIds) {
    // Try each candidate field in priority order and return the first non-empty
    // display text or raw value.
    for (let i = 0; i < fieldIds.length; i++) {
      const fieldId = fieldIds[i];
      let value = '';

      try {
        value = result.getText({ name: fieldId }) || '';
      } catch (e) { }

      if (!value) {
        try {
          value = result.getValue({ name: fieldId }) || '';
        } catch (e) { }
      }

      value = clean(value);
      if (value) return value;
    }

    return '';
  }

  function chooseEarliestDateTimeText(values) {
    // Some accounts have multiple creation-related fields. Choose the earliest
    // parseable timestamp, with a text fallback if parsing fails.
    let earliestDate = null;
    let earliestText = '';
    let fallbackText = '';

    (values || []).forEach(value => {
      const text = clean(value);
      if (!text) return;
      if (!fallbackText) fallbackText = text;

      const parsed = parseNsDateTime(text);
      if (!parsed) return;

      if (!earliestDate || parsed.getTime() < earliestDate.getTime()) {
        earliestDate = parsed;
        earliestText = text;
      }
    });

    return earliestText || fallbackText;
  }

  function getLoadableOptionalFields() {
    // Cache optional child-record field availability before building persisted
    // stage searches.
    return {
      approverText: hasOptionalField(ANALYTICS_FIELDS.APPROVER_TEXT),
      transitionType: hasOptionalField(ANALYTICS_FIELDS.TRANSITION_TYPE),
      waitMins: hasOptionalField(ANALYTICS_FIELDS.WAIT_MINS),
      slaBreached: hasOptionalField(ANALYTICS_FIELDS.SLA_BREACHED),
      isBottleneck: hasOptionalField(ANALYTICS_FIELDS.IS_BOTTLENECK)
    };
  }

  function hasOptionalField(fieldId) {
    if (Object.prototype.hasOwnProperty.call(STATE.optionalFieldCache, fieldId)) {
      return STATE.optionalFieldCache[fieldId];
    }

    let exists = false;
    try {
      // Same no-result search strategy used for transaction fields, but against
      // the child approval-stage record.
      search.create({
        type: CONFIG.childRecordType,
        filters: [['internalid', 'anyof', '@NONE@']],
        columns: [search.createColumn({ name: fieldId })]
      }).run().getRange({ start: 0, end: 1 });
      exists = true;
    } catch (e) {
      exists = false;
    }

    STATE.optionalFieldCache[fieldId] = exists;
    return exists;
  }

  function runPaged(nsSearch, eachResult) {
    // Standard helper for reading all result pages while keeping page size at the
    // NetSuite maximum.
    const paged = nsSearch.runPaged({ pageSize: 1000 });
    paged.pageRanges.forEach(pageRange => {
      const page = paged.fetch({ index: pageRange.index });
      page.data.forEach(eachResult);
    });
  }

  function resolvePurchaseOrderUrl(poId) {
    // Resolve a view-mode URL when possible; missing permissions or invalid IDs
    // simply omit the hyperlink.
    try {
      return url.resolveRecord({
        recordType: record.Type.PURCHASE_ORDER,
        recordId: poId,
        isEditMode: false
      });
    } catch (e) {
      return '';
    }
  }

  function isApprovedStatus(statusText) {
    // Treat post-approval PO statuses as approved because NetSuite moves approved
    // POs into receipt/billing states.
    const s = clean(statusText).toLowerCase();
    return s.indexOf('approved') >= 0 ||
      s.indexOf('pending receipt') >= 0 ||
      s.indexOf('pending bill') >= 0 ||
      s.indexOf('fully billed') >= 0 ||
      s.indexOf('partially received') >= 0;
  }

  function isPendingApprovalStatus(approvalStatusText, transactionStatusText) {
    // Approval status and transaction status can carry pending text depending on
    // the account/workflow configuration.
    const approval = clean(approvalStatusText).toLowerCase();
    const transaction = clean(transactionStatusText).toLowerCase();
    return approval.indexOf('pending approval') >= 0 ||
      transaction.indexOf('pending approval') >= 0 ||
      transaction.indexOf('pending supervisor approval') >= 0;
  }

  function isTerminalTransactionStatus(statusText) {
    // Terminal here means the PO should not be represented as an active current
    // approver fallback.
    const s = clean(statusText).toLowerCase();
    if (!s) return false;

    return s.indexOf('pending bill') >= 0 ||
      s.indexOf('pending billing') >= 0 ||
      s.indexOf('pending receipt') >= 0 ||
      s.indexOf('partially received') >= 0 ||
      s.indexOf('fully billed') >= 0 ||
      s.indexOf('closed') >= 0 ||
      s.indexOf('cancel') >= 0 ||
      s.indexOf('void') >= 0 ||
      s.indexOf('rejected') >= 0;
  }

  function parseDateParam(value) {
    // DATE parser for form filters and transaction dates.
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    const text = clean(value);
    if (!text) return null;

    try {
      // Use NetSuite's parser first to honor user/account date preferences.
      const parsed = format.parse({
        value: text,
        type: format.Type.DATE
      });
      if (parsed && !isNaN(parsed.getTime())) return parsed;
    } catch (e) { }

    // Native Date is a final fallback for test inputs or ISO-like strings.
    const nativeDate = new Date(text);
    return isNaN(nativeDate.getTime()) ? null : nativeDate;
  }

  function parseNsDateTime(value) {
    // DATETIMETZ is preferred for workflow/system note timestamps; DATETIME and
    // DATE parsing provide fallbacks for fields without timezone text.
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    const text = clean(value);
    if (!text) return null;

    try {
      const parsedTz = format.parse({
        value: text,
        type: format.Type.DATETIMETZ
      });
      if (parsedTz && !isNaN(parsedTz.getTime())) return parsedTz;
    } catch (e) { }

    try {
      const parsedDateTime = format.parse({
        value: text,
        type: format.Type.DATETIME
      });
      if (parsedDateTime && !isNaN(parsedDateTime.getTime())) return parsedDateTime;
    } catch (e) { }

    return parseDateParam(text);
  }

  function formatDate(dateObj) {
    // Format through NetSuite so the Suitelet respects account/user date settings.
    return format.format({
      value: dateObj,
      type: format.Type.DATE
    });
  }

  function formatDateTimeText(dateObj, fallbackText) {
    // Use fallback text when formatting is impossible so the UI does not lose a
    // source timestamp that was already readable.
    const fallback = clean(fallbackText);
    if (!dateObj) return fallback || '-';

    try {
      return format.format({
        value: dateObj,
        type: format.Type.DATETIMETZ
      });
    } catch (e) {
      return fallback || clean(dateObj) || '-';
    }
  }

  function formatCurrency(value) {
    // Render amount without a currency symbol so the caller can decide prefixing.
    const num = toNumber(value);
    return num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatMinutes(totalMinutes) {
    // Human-readable duration used consistently in dashboard, CSV, and Excel.
    totalMinutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) return days + 'd ' + hours + 'h ' + minutes + 'm';
    if (hours > 0) return hours + 'h ' + minutes + 'm';
    return minutes + 'm';
  }

  function diffMinutes(start, end) {
    // Negative or incomplete intervals are clamped to zero.
    const startDate = toDate(start);
    const endDate = toDate(end);

    if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) return 0;
    return Math.floor((endDate.getTime() - startDate.getTime()) / 60000);
  }

  function businessMinutesBetween(start, end) {
    // Count only Monday-Friday time inside the configured working day window.
    const startDate = toDate(start);
    const endDate = toDate(end);

    if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) return 0;

    let totalMinutes = 0;
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(), 0, 0, 0, 0);
    const lastDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate(), 0, 0, 0, 0);

    while (cursor.getTime() <= lastDay.getTime()) {
      const day = cursor.getDay();

      if (day >= 1 && day <= 5) {
        // Clip the requested interval to the workday bounds for each weekday.
        const workStart = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), CONFIG.workdayStartHour, 0, 0, 0);
        const workEnd = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), CONFIG.workdayEndHour, 0, 0, 0);
        const rangeStart = maxDate(startDate, workStart);
        const rangeEnd = minDate(endDate, workEnd);

        if (rangeEnd.getTime() > rangeStart.getTime()) {
          totalMinutes += Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / 60000);
        }
      }

      cursor.setDate(cursor.getDate() + 1);
    }

    return totalMinutes;
  }

  function toCsvRow(row) {
    // Quote every CSV cell; this handles commas, quotes, and line breaks safely.
    return row.map(cell => {
      const value = clean(cell);
      return '"' + value.replace(/"/g, '""') + '"';
    }).join(',');
  }

  function toNumber(value) {
    // Normalize NetSuite number strings that may include thousands separators.
    const number = Number((clean(value) || '0').replace(/,/g, ''));
    return isNaN(number) ? 0 : number;
  }

  function toInteger(value) {
    // Strict base-10 parsing for page indexes and similar request params.
    const number = parseInt(clean(value) || '0', 10);
    return isNaN(number) ? 0 : number;
  }

  function toDate(value) {
    // Convert native Date or date-like text into a valid Date object.
    if (Object.prototype.toString.call(value) === '[object Date]') {
      return isNaN(value.getTime()) ? null : value;
    }

    const text = clean(value);
    if (!text) return null;

    const parsed = new Date(text);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  function maxDate(a, b) {
    return a.getTime() >= b.getTime() ? a : b;
  }

  function minDate(a, b) {
    return a.getTime() <= b.getTime() ? a : b;
  }

  function stripTime(value) {
    // Date filters should start at midnight to avoid time-of-day surprises.
    const d = new Date(value.getTime());
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function addDays(dateObj, days) {
    // Clone before mutating so callers do not accidentally shift their input date.
    const d = new Date(dateObj.getTime());
    d.setDate(d.getDate() + Number(days || 0));
    return d;
  }

  function chunkArray(values, size) {
    // General helper for keeping search filters under practical NetSuite limits.
    const chunks = [];
    for (let i = 0; i < values.length; i += size) {
      chunks.push(values.slice(i, i + size));
    }
    return chunks;
  }

  function uniqueTruthy(values) {
    // Deduplicate after clean() so whitespace-only and null-like adapter values
    // are discarded consistently.
    const seen = {};
    const out = [];

    values.forEach(value => {
      const key = clean(value);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push(key);
    });

    return out;
  }

  function extractApproverFromName(name) {
    // Persisted child record names may include prefix pieces before the approver.
    const parts = clean(name).split(' - ');
    return parts.length >= 3 ? parts.slice(2).join(' - ') : '';
  }

  function normalizeFieldName(value) {
    // Collapse labels/internal IDs into a comparison-safe lowercase token.
    return clean(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function toBool(value) {
    // Accept NetSuite checkbox values plus common URL/test boolean aliases.
    const text = clean(value).toUpperCase();
    return value === true || text === 'T' || text === 'TRUE' || text === 'Y' || text === 'YES' || text === '1';
  }

  function describeError(e) {
    // Normalize NetSuite adapter errors into support-readable text.
    const name = clean(e && e.name) || 'Error';
    const message = clean(e && e.message) || clean(e);

    if (!message || isNullAdapterText(message)) {
      return name === 'Error' ? 'Unexpected NetSuite null value returned while loading workflow timing.' : name;
    }

    return name + ': ' + message;
  }

  function logWorkflowHistoryFallbackFailure(title, e, poId) {
    // Workflow-locked records are expected for active approvals, so log them at
    // debug level instead of error level.
    const details = (poId ? 'PO internal ID ' + poId + ': ' : '') + describeError(e);

    if (isRecordLockedByWorkflowError(e)) {
      log.debug({
        title: title.replace('failed', 'skipped'),
        details: details
      });
      return;
    }

    log.error({
      title: title,
      details: details
    });
  }

  function isRecordLockedByWorkflowError(e) {
    // Detect the common NetSuite workflow lock message from name/message/string.
    const text = (
      clean(e && e.name) + ' ' +
      clean(e && e.message) + ' ' +
      clean(e)
    ).toUpperCase();

    return text.indexOf('RCRD_LOCKED_BY_WF') !== -1 ||
      text.indexOf('LOCKED BY A USER DEFINED WORKFLOW') !== -1;
  }

  function clean(value) {
    // One cleanup path for user input, NetSuite search values, and adapter objects.
    if (isNullAdapterValue(value)) return '';

    let text = '';
    try {
      text = String(value == null ? '' : value).trim();
    } catch (e) {
      return '';
    }

    return isNullAdapterText(text) ? '' : text;
  }

  function isEmptyValue(value) {
    // Empty includes NetSuite adapter nulls, not just JavaScript null/empty string.
    return value === '' || value == null || isNullAdapterValue(value) || clean(value) === '';
  }

  function isNullAdapterValue(value) {
    // NetSuite sometimes returns Java adapter placeholders that stringify poorly
    // and should be treated as empty values.
    if (value == null) return true;
    if (Object.prototype.toString.call(value) === '[object Date]') return false;

    let text = '';
    try {
      text = String(value);
    } catch (e) {
      return true;
    }

    return isNullAdapterText(text);
  }

  function isNullAdapterText(text) {
    // Known placeholder text emitted by NetSuite's script object adapters.
    return String(text || '').indexOf('ScriptNullObjectAdapter') >= 0 ||
      String(text || '').indexOf('com.netsuite.suitescript.scriptobject') >= 0;
  }

  function esc(value) {
    // Escape text inserted into inline HTML.
    if (isNullAdapterValue(value)) return '';
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    // Attribute escaping adds backtick handling on top of standard HTML escaping.
    return esc(value).replace(/`/g, '&#96;');
  }

  return { onRequest };
});
