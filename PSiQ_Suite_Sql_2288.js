/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/ui/serverWidget', 'N/query'], (ui, query) => {
  const DEFAULT_MAX_ROWS = 100;
  const MAX_ALLOWED_ROWS = 1000;
  const MIN_PAGE_SIZE = 5;
  const MAX_PAGE_SIZE = 1000;
  const DEFAULT_CLIENT_PAGE_SIZE = 50;
  const QUERY_HISTORY_LIMIT = 10;

  const DEFAULT_SQL = `SELECT id, itemid, displayname, itemtype
FROM item
ORDER BY itemid`;

  const EXAMPLE_QUERIES = [
    {
      id: 'items',
      label: 'Items',
      sql: DEFAULT_SQL
    },
    {
      id: 'vendors',
      label: 'Vendors',
      sql: `SELECT id, entityid, companyname, email
FROM vendor
WHERE isinactive = 'F'
ORDER BY entityid`
    },
    {
      id: 'purchase_orders',
      label: 'Purchase Orders',
      sql: `SELECT id, tranid, trandate, entity, status
FROM transaction
WHERE type = 'PurchOrd'
ORDER BY trandate DESC`
    },
    {
      id: 'transactions',
      label: 'Transactions',
      sql: `SELECT id, tranid, type, trandate, entity, status
FROM transaction
ORDER BY trandate DESC`
    }
  ];

  function onRequest(ctx) {
    const params = ctx.request.parameters || {};
    const rawSql = getParameter(params, 'custpage_sql', DEFAULT_SQL);
    const selectedExample = params.custpage_example || '';
    const appliedExample = params.custpage_applied_example || '';
    const sql = shouldUseSelectedExample(rawSql, selectedExample, appliedExample)
      ? getExampleSql(selectedExample)
      : rawSql;
    const maxRows = normalizeMaxRows(params.custpage_max_rows);
    const action = params.custpage_action || 'run';
    const effectiveAppliedExample = sql === getExampleSql(selectedExample)
      ? selectedExample
      : appliedExample;

    if (ctx.request.method === 'POST') {
      const result = runSql(sql, maxRows);

      if (action === 'csv' && !result.error) {
        writeCsvResponse(ctx, result.rows);
        return;
      }

      ctx.response.writePage(buildForm({
        sql,
        maxRows,
        selectedExample,
        appliedExample: effectiveAppliedExample,
        result
      }));
      return;
    }

    ctx.response.writePage(buildForm({
      sql,
      maxRows,
      selectedExample,
      appliedExample: effectiveAppliedExample
    }));
  }

  function buildForm(options) {
    const form = ui.createForm({ title: 'SuiteQL Runner' });

    form.addFieldGroup({
      id: 'custpage_query_group',
      label: 'Query'
    });

    form.addFieldGroup({
      id: 'custpage_results_group',
      label: 'Results'
    });

    const exampleField = form.addField({
      id: 'custpage_example',
      type: ui.FieldType.SELECT,
      label: 'Examples',
      container: 'custpage_query_group'
    });
    exampleField.updateLayoutType({
      layoutType: ui.FieldLayoutType.STARTROW
    });

    exampleField.addSelectOption({
      value: '',
      text: 'Select an example',
      isSelected: !options.selectedExample
    });

    EXAMPLE_QUERIES.forEach(example => {
      exampleField.addSelectOption({
        value: example.id,
        text: example.label,
        isSelected: options.selectedExample === example.id
      });
    });

    const maxRowsField = form.addField({
      id: 'custpage_max_rows',
      type: ui.FieldType.INTEGER,
      label: 'Max Rows',
      container: 'custpage_query_group'
    });
    maxRowsField.defaultValue = String(options.maxRows || DEFAULT_MAX_ROWS);
    maxRowsField.updateLayoutType({
      layoutType: ui.FieldLayoutType.MIDROW
    });

    const actionField = form.addField({
      id: 'custpage_action',
      type: ui.FieldType.TEXT,
      label: 'Action',
      container: 'custpage_query_group'
    });
    actionField.updateDisplayType({
      displayType: ui.FieldDisplayType.HIDDEN
    });
    actionField.defaultValue = 'run';

    const appliedExampleField = form.addField({
      id: 'custpage_applied_example',
      type: ui.FieldType.TEXT,
      label: 'Applied Example',
      container: 'custpage_query_group'
    });
    appliedExampleField.updateDisplayType({
      displayType: ui.FieldDisplayType.HIDDEN
    });
    appliedExampleField.defaultValue = options.appliedExample || '';

    const queryToolsField = form.addField({
      id: 'custpage_query_tools',
      type: ui.FieldType.INLINEHTML,
      label: 'Query Tools',
      container: 'custpage_query_group'
    });
    queryToolsField.defaultValue = buildQueryToolsHtml();
    queryToolsField.updateLayoutType({
      layoutType: ui.FieldLayoutType.OUTSIDEBELOW
    });

    const sqlField = form.addField({
      id: 'custpage_sql',
      type: ui.FieldType.LONGTEXT,
      label: 'SuiteQL',
      container: 'custpage_query_group'
    });
    sqlField.defaultValue = options.sql || DEFAULT_SQL;
    sqlField.updateLayoutType({
      layoutType: ui.FieldLayoutType.OUTSIDEBELOW
    });

    const resultsField = form.addField({
      id: 'custpage_results',
      type: ui.FieldType.INLINEHTML,
      label: 'Results',
      container: 'custpage_results_group'
    });
    resultsField.defaultValue = buildResultsHtml(options.result);
    resultsField.updateLayoutType({
      layoutType: ui.FieldLayoutType.OUTSIDEBELOW
    });

    form.addSubmitButton({ label: 'Run' });
    form.addButton({
      id: 'custpage_clear_sql',
      label: 'Clear',
      functionName: "if(window.psiqSuiteSqlClear){window.psiqSuiteSqlClear();}"
    });
    form.addButton({
      id: 'custpage_reset_example',
      label: 'Reset Example',
      functionName: "if(window.psiqSuiteSqlResetExample){window.psiqSuiteSqlResetExample();}"
    });
    form.addButton({
      id: 'custpage_download_csv',
      label: 'Download CSV',
      functionName: "if(window.psiqSuiteSqlDownloadCsv){window.psiqSuiteSqlDownloadCsv();}"
    });
    form.addButton({
      id: 'custpage_format_sql',
      label: 'Format SQL',
      functionName: "if(window.psiqSuiteSqlFormat){window.psiqSuiteSqlFormat();}"
    });
    form.addButton({
      id: 'custpage_copy_sql',
      label: 'Copy SQL',
      functionName: "if(window.psiqSuiteSqlCopySql){window.psiqSuiteSqlCopySql();}"
    });
    form.addButton({
      id: 'custpage_copy_results',
      label: 'Copy Results',
      functionName: "if(window.psiqSuiteSqlCopyResults){window.psiqSuiteSqlCopyResults();}"
    });

    return form;
  }

  function runSql(sql, maxRows) {
    const started = Date.now();

    try {
      const normalizedSql = normalizeSql(sql);
      const rows = [];
      const pageSize = Math.min(Math.max(maxRows, MIN_PAGE_SIZE), MAX_PAGE_SIZE);
      const paged = query.runSuiteQLPaged({
        query: normalizedSql,
        pageSize
      });

      for (let i = 0; i < paged.pageRanges.length && rows.length < maxRows; i++) {
        const page = paged.fetch({ index: paged.pageRanges[i].index });
        const pageRows = page.data.asMappedResults();

        for (let j = 0; j < pageRows.length && rows.length < maxRows; j++) {
          rows.push(pageRows[j]);
        }
      }

      const totalRows = typeof paged.count === 'number' ? paged.count : null;

      return {
        sql: normalizedSql,
        rows,
        maxRows,
        totalRows,
        truncated: totalRows !== null ? totalRows > rows.length : rows.length >= maxRows,
        elapsedMs: Date.now() - started
      };
    } catch (e) {
      return {
        sql,
        error: e,
        maxRows,
        elapsedMs: Date.now() - started
      };
    }
  }

  function normalizeSql(sql) {
    const normalized = String(sql || '').trim().replace(/;\s*$/, '');

    if (!normalized) {
      throw new Error('Enter a SuiteQL query before running.');
    }

    if (!/^(select|with)\b/i.test(normalized)) {
      throw new Error('Only SELECT and WITH queries are allowed.');
    }

    if (normalized.indexOf(';') !== -1) {
      throw new Error('Run one SuiteQL statement at a time.');
    }

    return normalized;
  }

  function normalizeMaxRows(rawValue) {
    const parsed = parseInt(rawValue, 10);

    if (!parsed || parsed < 1) {
      return DEFAULT_MAX_ROWS;
    }

    return Math.min(parsed, MAX_ALLOWED_ROWS);
  }

  function getParameter(params, name, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      return params[name];
    }

    return defaultValue;
  }

  function getExampleSql(exampleId) {
    for (let i = 0; i < EXAMPLE_QUERIES.length; i++) {
      if (EXAMPLE_QUERIES[i].id === exampleId) {
        return EXAMPLE_QUERIES[i].sql;
      }
    }

    return '';
  }

  function shouldUseSelectedExample(rawSql, selectedExample, appliedExample) {
    if (!selectedExample || selectedExample === appliedExample || !getExampleSql(selectedExample)) {
      return false;
    }

    return isExampleSql(rawSql);
  }

  function isExampleSql(sql) {
    const normalized = normalizeSqlText(sql);

    return EXAMPLE_QUERIES.some(example => normalizeSqlText(example.sql) === normalized);
  }

  function normalizeSqlText(sql) {
    return String(sql || '')
      .replace(/\r\n/g, '\n')
      .trim();
  }

  function buildQueryToolsHtml() {
    return [
      '<style>',
      '#custpage_sql{width:min(1120px,calc(100vw - 96px))!important;height:260px!important;font-family:Consolas,Monaco,monospace!important;font-size:13px!important;line-height:1.45!important;}',
      '#custpage_max_rows{width:120px!important;}',
      '.psiq-sql-query-tools{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px 14px;margin:10px 0 8px;font-family:Arial,Helvetica,sans-serif;color:#1f2933;}',
      '.psiq-sql-query-tools label{display:flex;flex-direction:column;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;color:#5f6b7a;}',
      '.psiq-sql-query-tools select{min-width:230px;height:30px;border:1px solid #b9c4d0;background:#fff;color:#1f2933;font-size:12px;}',
      '.psiq-sql-query-tools button{height:30px;border:1px solid #b9c4d0;background:#f7f9fb;color:#1f2933;border-radius:4px;padding:0 10px;font-size:12px;font-weight:700;cursor:pointer;}',
      '.psiq-sql-query-tools button:hover{background:#edf2f7;}',
      '.psiq-sql-tool-status{min-height:16px;font-size:12px;color:#4b5563;}',
      '.psiq-sql-loading{display:none;position:fixed;right:18px;bottom:18px;z-index:99999;padding:10px 14px;border:1px solid #93b5d8;background:#eff6ff;color:#163b65;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;box-shadow:0 6px 18px rgba(31,41,55,.18);}',
      '</style>',
      '<div class="psiq-sql-query-tools" aria-label="SuiteQL query tools">',
      '<label>Favorites<select id="psiq-sql-favorites" onchange="if(window.psiqSuiteSqlLoadFavorite){window.psiqSuiteSqlLoadFavorite();}"><option value="">Load favorite</option></select></label>',
      '<button id="psiq-sql-load-favorite" type="button">Load</button>',
      '<button id="psiq-sql-save-favorite" type="button">Save Favorite</button>',
      '<button id="psiq-sql-delete-favorite" type="button">Delete Favorite</button>',
      '<label>History<select id="psiq-sql-history"><option value="">Recent queries</option></select></label>',
      '<button id="psiq-sql-load-history" type="button">Load</button>',
      '<button id="psiq-sql-clear-history" type="button">Clear History</button>',
      '<span id="psiq-sql-tool-status" class="psiq-sql-tool-status"></span>',
      '</div>',
      '<div id="psiq-sql-loading" class="psiq-sql-loading">Running SuiteQL...</div>'
    ].join('');
  }

  function buildResultsHtml(result) {
    if (!result) {
      return buildClientBehaviorHtml(null) + '<div class="psiq-sql-results"></div>';
    }

    const css = [
      '<style>',
      '.psiq-sql-results{font-family:Arial,Helvetica,sans-serif;margin-top:12px;color:#1f2933;}',
      '.psiq-sql-summary{display:flex;flex-wrap:wrap;gap:8px 14px;margin:0 0 12px;padding:10px 12px;border:1px solid #c8d5e3;background:#f4f8fb;border-radius:4px;}',
      '.psiq-sql-summary span{font-size:12px;font-weight:600;line-height:1.4;}',
      '.psiq-sql-error{margin:0 0 12px;padding:12px;border:1px solid #e0a6a6;background:#fff5f5;color:#7f1d1d;border-radius:4px;}',
      '.psiq-sql-error strong{display:block;margin-bottom:6px;}',
      '.psiq-sql-error pre{white-space:pre-wrap;margin:0;font-family:Consolas,Monaco,monospace;font-size:12px;}',
      '.psiq-sql-result-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 10px;}',
      '.psiq-sql-result-tools input,.psiq-sql-result-tools select{height:30px;border:1px solid #b9c4d0;background:#fff;color:#1f2933;font-size:12px;border-radius:3px;}',
      '.psiq-sql-result-tools input{width:260px;padding:0 8px;}',
      '.psiq-sql-result-tools select{padding:0 6px;}',
      '.psiq-sql-result-tools button{height:30px;border:1px solid #b9c4d0;background:#f7f9fb;color:#1f2933;border-radius:4px;padding:0 10px;font-size:12px;font-weight:700;cursor:pointer;}',
      '.psiq-sql-result-tools button:hover{background:#edf2f7;}',
      '.psiq-sql-page-status{font-size:12px;font-weight:700;color:#4b5563;}',
      '.psiq-sql-table-wrap{overflow:auto;max-height:640px;border:1px solid #d9e2ec;border-radius:4px;background:#fff;width:min(1240px,calc(100vw - 84px));}',
      '.psiq-sql-table{border-collapse:collapse;width:100%;font-size:12px;}',
      '.psiq-sql-table th{position:sticky;top:0;z-index:1;background:#e8eef5;border-bottom:1px solid #cbd5e1;text-align:left;padding:7px 8px;font-weight:700;white-space:nowrap;}',
      '.psiq-sql-table td{border-top:1px solid #edf2f7;padding:6px 8px;vertical-align:top;white-space:nowrap;}',
      '.psiq-sql-table tbody tr:nth-child(even){background:#fbfdff;}',
      '.psiq-sql-table tbody tr:hover{background:#eef6ff;}',
      '.psiq-sql-cell-text{display:inline-block;max-width:460px;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom;}',
      '.psiq-sql-number{text-align:right;font-variant-numeric:tabular-nums;}',
      '.psiq-sql-null,.psiq-sql-empty-value{color:#7b8794;font-style:italic;}',
      '.psiq-sql-open-link{color:#0b63ce;text-decoration:none;font-weight:700;}',
      '.psiq-sql-open-link:hover{text-decoration:underline;}',
      '.psiq-sql-empty{padding:12px;border:1px solid #d9e2ec;background:#fff;border-radius:4px;}',
      '.psiq-sql-json{margin-top:12px;}',
      '.psiq-sql-json summary{cursor:pointer;font-weight:700;margin-bottom:8px;}',
      '.psiq-sql-json pre{overflow:auto;max-height:420px;padding:12px;border:1px solid #d9e2ec;background:#111827;color:#f9fafb;border-radius:4px;font-family:Consolas,Monaco,monospace;font-size:12px;}',
      '</style>'
    ].join('');

    if (result.error) {
      return [
        css,
        '<div class="psiq-sql-results">',
        buildSummaryHtml(result, false),
        '<div class="psiq-sql-error">',
        '<strong>SuiteQL Error</strong>',
        '<pre>',
        escapeHtml(getErrorText(result.error)),
        '</pre>',
        '</div>',
        '</div>',
        buildClientBehaviorHtml(result)
      ].join('');
    }

    return [
      css,
      '<div class="psiq-sql-results">',
      buildSummaryHtml(result, true),
      buildResultToolbarHtml(result.rows || []),
      buildTableHtml(result.rows || [], result.sql || ''),
      buildJsonHtml(result.rows || []),
      '</div>',
      buildClientBehaviorHtml(result)
    ].join('');
  }

  function buildClientBehaviorHtml(result) {
    const examples = {};
    const labels = {};
    const builtInFavorites = [];
    const resultRows = result && !result.error ? result.rows || [] : [];
    const resultColumns = getColumns(resultRows);

    EXAMPLE_QUERIES.forEach(example => {
      examples[example.id] = example.sql;
      labels[example.label] = example.id;
      builtInFavorites.push({
        id: example.id,
        label: example.label,
        sql: example.sql
      });
    });

    return [
      '<script>',
      '(function(){',
      "var historyKey='psiqSuiteSqlHistory';",
      "var favoritesKey='psiqSuiteSqlFavorites';",
      `var examples=${jsString(examples)};`,
      `var labels=${jsString(labels)};`,
      `var builtInFavorites=${jsString(builtInFavorites)};`,
      `var resultRows=${jsString(resultRows)};`,
      `var resultColumns=${jsString(resultColumns)};`,
      `var historyLimit=${QUERY_HISTORY_LIMIT};`,
      "var lastExample='';",
      "var currentPage=0;",
      "var filteredResultRows=[];",
      "function byId(id){return document.getElementById(id);}",
      "function safeParse(value,fallback){try{return JSON.parse(value)||fallback;}catch(e){return fallback;}}",
      "function getStorage(key,fallback){try{return safeParse(localStorage.getItem(key),fallback);}catch(e){return fallback;}}",
      "function setStorage(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch(e){}}",
      "function setStatus(message){var field=byId('psiq-sql-tool-status');if(field){field.textContent=message||'';if(message){window.setTimeout(function(){field.textContent='';},2400);}}}",
      "function setDomValue(fieldId,value){var field=byId(fieldId);if(field){field.value=value;try{field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}}}",
      "function setFieldValue(fieldId,value){if(typeof nlapiSetFieldValue==='function'){try{nlapiSetFieldValue(fieldId,value,false,true);}catch(e){}}setDomValue(fieldId,value);}",
      "function getFieldValue(fieldId){if(typeof nlapiGetFieldValue==='function'){try{return nlapiGetFieldValue(fieldId)||'';}catch(e){}}var field=byId(fieldId);return field?field.value:'';}",
      "function getFieldText(fieldId){if(typeof nlapiGetFieldText==='function'){try{return nlapiGetFieldText(fieldId)||'';}catch(e){}}var input=byId('inpt_'+fieldId+'1')||byId('inpt_'+fieldId);return input?input.value:'';}",
      "function setAction(action){setFieldValue('custpage_action',action);}",
      "function getAction(){return getFieldValue('custpage_action');}",
      "function getSql(){return getFieldValue('custpage_sql');}",
      "function setSql(sql){setFieldValue('custpage_sql',sql);}",
      "function getExampleValue(){var value=getFieldValue('custpage_example');if(examples[value]){return value;}var text=getFieldText('custpage_example');return labels[text]||value;}",
      "function syncExample(){var value=getExampleValue();if(value&&examples[value]){setFieldValue('custpage_sql',examples[value]);setFieldValue('custpage_applied_example',value);setAction('run');lastExample=value;}}",
      "function bindExampleEvents(){var ids=['custpage_example','inpt_custpage_example','inpt_custpage_example1'];for(var i=0;i<ids.length;i++){var field=byId(ids[i]);if(field&&!field._psiqSqlBound){field._psiqSqlBound=true;field.addEventListener('change',syncExample);field.addEventListener('blur',syncExample);field.addEventListener('keyup',syncExample);}}}",
      "function watchExample(){bindExampleEvents();var value=getExampleValue();if(value&&value!==lastExample){syncExample();}}",
      "function normalizeSqlForHistory(sql){return String(sql||'').replace(/\\r\\n/g,'\\n').trim();}",
      "function getSqlTitle(sql){var first=normalizeSqlForHistory(sql).split('\\n')[0]||'SuiteQL query';return first.length>80?first.substring(0,77)+'...':first;}",
      "function rememberHistory(){var sql=normalizeSqlForHistory(getSql());if(!sql){return;}var history=getStorage(historyKey,[]).filter(function(item){return item&&item.sql!==sql;});history.unshift({label:getSqlTitle(sql),sql:sql,ts:new Date().toISOString()});history=history.slice(0,historyLimit);setStorage(historyKey,history);renderHistory();}",
      "function renderHistory(){var select=byId('psiq-sql-history');if(!select){return;}var history=getStorage(historyKey,[]);select.innerHTML='<option value=\"\">Recent queries</option>';history.forEach(function(item,index){var option=document.createElement('option');option.value=String(index);option.textContent=item.label||getSqlTitle(item.sql);select.appendChild(option);});}",
      "function renderFavorites(){var select=byId('psiq-sql-favorites');if(!select){return;}var saved=getStorage(favoritesKey,[]);select.innerHTML='<option value=\"\">Load favorite</option>';builtInFavorites.forEach(function(item){var option=document.createElement('option');option.value='builtin:'+item.id;option.textContent=item.label;select.appendChild(option);});if(saved.length){var divider=document.createElement('option');divider.disabled=true;divider.textContent='Saved favorites';select.appendChild(divider);}saved.forEach(function(item,index){var option=document.createElement('option');option.value='saved:'+index;option.textContent=item.name||getSqlTitle(item.sql);select.appendChild(option);});}",
      "function getFavoriteSelection(){var select=byId('psiq-sql-favorites');return select?select.value:'';}",
      "function loadFavoriteValue(value){if(!value){return;}if(value.indexOf('builtin:')===0){var id=value.substring(8);if(examples[id]){setSql(examples[id]);setFieldValue('custpage_example',id);setFieldValue('custpage_applied_example',id);lastExample=id;setStatus('Favorite loaded');}}else if(value.indexOf('saved:')===0){var saved=getStorage(favoritesKey,[]);var item=saved[parseInt(value.substring(6),10)];if(item&&item.sql){setSql(item.sql);setFieldValue('custpage_example','');setFieldValue('custpage_applied_example','');lastExample='';setStatus('Favorite loaded');}}setAction('run');}",
      "function formatSqlText(sql){var strings=[];var text=String(sql||'').replace(/'([^']|'')*'|\"([^\"]|\"\")*\"/g,function(match){var token='__PSIQ_SQL_STRING_'+strings.length+'__';strings.push(match);return token;});text=text.replace(/\\s+/g,' ').trim();if(!text){return '';}text=text.replace(/\\b(select|from|where|group by|having|order by)\\b/gi,function(match){return '\\n'+match.toUpperCase();});text=text.replace(/\\b(inner join|left join|right join|full join|cross join|join)\\b/gi,function(match){return '\\n'+match.toUpperCase();});text=text.replace(/\\b(and|or)\\b/gi,function(match){return '\\n  '+match.toUpperCase();});text=text.replace(/,\\s*/g,', ');strings.forEach(function(value,index){text=text.replace('__PSIQ_SQL_STRING_'+index+'__',value);});return text.replace(/^\\n/,'').trim();}",
      "function copyText(text,label){if(!text){setStatus('Nothing to copy');return;}function done(){setStatus((label||'Text')+' copied');}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text);done();});}else{fallbackCopy(text);done();}}",
      "function fallbackCopy(text){var area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.left='-9999px';document.body.appendChild(area);area.focus();area.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(area);}",
      "function rowMatchesSearch(row,term){if(!term){return true;}var text=resultColumns.map(function(column){var value=row[column];return value===null||value===undefined?'NULL':String(value);}).join(' ').toLowerCase();return text.indexOf(term)!==-1;}",
      "function getFilteredResultRows(){var search=byId('psiq-sql-result-search');var term=search?String(search.value||'').toLowerCase():'';return resultRows.filter(function(row){return rowMatchesSearch(row,term);});}",
      "function copyResults(){var rows=getFilteredResultRows();if(!rows.length||!resultColumns.length){setStatus('No results to copy');return;}var out=[resultColumns.join('\\t')];rows.forEach(function(row){out.push(resultColumns.map(function(column){var value=row[column];return value===null||value===undefined?'NULL':String(value);}).join('\\t'));});copyText(out.join('\\n'),'Results');}",
      "function showLoading(){var loading=byId('psiq-sql-loading');if(loading){loading.style.display='block';}var buttons=document.querySelectorAll('input[type=submit],button');for(var i=0;i<buttons.length;i++){buttons[i].disabled=true;}}",
      "function getPageSize(){var select=byId('psiq-sql-page-size');if(!select||select.value==='all'){return 0;}var parsed=parseInt(select.value,10);return parsed>0?parsed:50;}",
      "function applyResultView(){var table=byId('psiq-sql-result-table');if(!table){return;}var bodyRows=Array.prototype.slice.call(table.querySelectorAll('tbody tr'));var search=byId('psiq-sql-result-search');var term=search?String(search.value||'').toLowerCase():'';var pageSize=getPageSize();filteredResultRows=[];bodyRows.forEach(function(row){var match=!term||String(row.getAttribute('data-psiq-search')||'').indexOf(term)!==-1;if(match){filteredResultRows.push(row);}});var total=filteredResultRows.length;var maxPage=pageSize?Math.max(0,Math.ceil(total/pageSize)-1):0;if(currentPage>maxPage){currentPage=maxPage;}bodyRows.forEach(function(row){row.style.display='none';});var start=pageSize?currentPage*pageSize:0;var end=pageSize?Math.min(start+pageSize,total):total;for(var i=start;i<end;i++){filteredResultRows[i].style.display='';}var status=byId('psiq-sql-page-status');if(status){status.textContent=total?('Showing '+(start+1)+'-'+end+' of '+total):'No matching rows';}}",
      "function bindResultTools(){var search=byId('psiq-sql-result-search');if(search&&!search._psiqSqlBound){search._psiqSqlBound=true;search.addEventListener('input',function(){currentPage=0;applyResultView();});}var pageSize=byId('psiq-sql-page-size');if(pageSize&&!pageSize._psiqSqlBound){pageSize._psiqSqlBound=true;pageSize.addEventListener('change',function(){currentPage=0;applyResultView();});}applyResultView();}",
      "function bindButton(id,handler){var button=byId(id);if(button&&!button._psiqSqlBound){button._psiqSqlBound=true;button.addEventListener('click',function(event){event.preventDefault();handler();});}}",
      "function bindQueryToolEvents(){var favorites=byId('psiq-sql-favorites');if(favorites&&!favorites._psiqSqlBound){favorites._psiqSqlBound=true;favorites.addEventListener('change',function(){loadFavoriteValue(getFavoriteSelection());});}bindButton('psiq-sql-load-favorite',function(){loadFavoriteValue(getFavoriteSelection());});bindButton('psiq-sql-save-favorite',function(){window.psiqSuiteSqlSaveFavorite();});bindButton('psiq-sql-delete-favorite',function(){window.psiqSuiteSqlDeleteFavorite();});bindButton('psiq-sql-load-history',function(){window.psiqSuiteSqlLoadHistory();});bindButton('psiq-sql-clear-history',function(){window.psiqSuiteSqlClearHistory();});}",
      "window.psiqSuiteSqlClear=function(){setSql('');setFieldValue('custpage_example','');setFieldValue('custpage_applied_example','');setAction('run');lastExample='';setStatus('Query cleared');};",
      "window.psiqSuiteSqlResetExample=function(){setFieldValue('custpage_example','items');setSql(examples.items);setFieldValue('custpage_applied_example','items');setAction('run');lastExample='items';setStatus('Example reset');};",
      "window.psiqSuiteSqlDownloadCsv=function(){rememberHistory();setAction('csv');showLoading();if(document.forms&&document.forms[0]){document.forms[0].submit();}window.setTimeout(function(){setAction('run');},500);};",
      "window.psiqSuiteSqlFormat=function(){setSql(formatSqlText(getSql()));setAction('run');setStatus('SQL formatted');};",
      "window.psiqSuiteSqlCopySql=function(){copyText(getSql(),'SQL');};",
      "window.psiqSuiteSqlCopyResults=copyResults;",
      "window.psiqSuiteSqlClearResultSearch=function(){var search=byId('psiq-sql-result-search');if(search){search.value='';currentPage=0;applyResultView();}};",
      "window.psiqSuiteSqlPrevPage=function(){if(currentPage>0){currentPage--;applyResultView();}};",
      "window.psiqSuiteSqlNextPage=function(){var pageSize=getPageSize();if(!pageSize){return;}var maxPage=Math.max(0,Math.ceil(filteredResultRows.length/pageSize)-1);if(currentPage<maxPage){currentPage++;applyResultView();}};",
      "window.psiqSuiteSqlLoadFavorite=function(){loadFavoriteValue(getFavoriteSelection());};",
      "window.psiqSuiteSqlSaveFavorite=function(){var sql=normalizeSqlForHistory(getSql());if(!sql){setStatus('Nothing to save');return;}var name=prompt('Favorite name',getSqlTitle(sql));if(!name){return;}var saved=getStorage(favoritesKey,[]).filter(function(item){return item&&item.name!==name;});saved.push({name:name,sql:sql,ts:new Date().toISOString()});setStorage(favoritesKey,saved);renderFavorites();setStatus('Favorite saved');};",
      "window.psiqSuiteSqlDeleteFavorite=function(){var value=getFavoriteSelection();if(value.indexOf('saved:')!==0){setStatus('Select a saved favorite');return;}var index=parseInt(value.substring(6),10);var saved=getStorage(favoritesKey,[]);saved.splice(index,1);setStorage(favoritesKey,saved);renderFavorites();setStatus('Favorite deleted');};",
      "window.psiqSuiteSqlLoadHistory=function(){var select=byId('psiq-sql-history');if(!select||select.value===''){return;}var history=getStorage(historyKey,[]);var item=history[parseInt(select.value,10)];if(item&&item.sql){setSql(item.sql);setFieldValue('custpage_example','');setFieldValue('custpage_applied_example','');lastExample='';setAction('run');setStatus('History loaded');}};",
      "window.psiqSuiteSqlClearHistory=function(){setStorage(historyKey,[]);renderHistory();setStatus('History cleared');};",
      "var form=document.forms&&document.forms[0];if(form){form.addEventListener('submit',function(){if(getAction()!=='csv'){rememberHistory();setAction('run');showLoading();}});}",
      "renderFavorites();renderHistory();bindQueryToolEvents();bindResultTools();bindExampleEvents();lastExample=getFieldValue('custpage_applied_example')||'';watchExample();window.setTimeout(function(){bindExampleEvents();bindQueryToolEvents();},250);window.setTimeout(function(){bindExampleEvents();bindQueryToolEvents();bindResultTools();},1000);window.setInterval(watchExample,300);",
      '})();',
      '</script>'
    ].join('');
  }

  function buildSummaryHtml(result, success) {
    const rows = result.rows || [];
    const totalText = result.totalRows === null || result.totalRows === undefined
      ? ''
      : `<span>Total available: ${escapeHtml(String(result.totalRows))}</span>`;
    const cappedText = result.truncated ? '<span>Limited preview</span>' : '';

    return [
      `<div class="psiq-sql-summary ${success ? 'psiq-sql-success' : 'psiq-sql-failed'}">`,
      `<span>Status: ${success ? 'Success' : 'Error'}</span>`,
      `<span>Rows returned: ${escapeHtml(String(rows.length))}</span>`,
      totalText,
      `<span>Max rows: ${escapeHtml(String(result.maxRows || DEFAULT_MAX_ROWS))}</span>`,
      `<span>Elapsed: ${escapeHtml(String(result.elapsedMs || 0))} ms</span>`,
      cappedText,
      '</div>'
    ].join('');
  }

  function buildResultToolbarHtml(rows) {
    if (!rows.length) {
      return '';
    }

    return [
      '<div class="psiq-sql-result-tools" aria-label="SuiteQL result tools">',
      '<input id="psiq-sql-result-search" type="search" placeholder="Search results">',
      '<button type="button" onclick="if(window.psiqSuiteSqlClearResultSearch){window.psiqSuiteSqlClearResultSearch();}">Clear Search</button>',
      '<span>Rows per page</span>',
      '<select id="psiq-sql-page-size">',
      '<option value="25">25</option>',
      `<option value="${DEFAULT_CLIENT_PAGE_SIZE}" selected>${DEFAULT_CLIENT_PAGE_SIZE}</option>`,
      '<option value="100">100</option>',
      '<option value="all">All</option>',
      '</select>',
      '<button type="button" onclick="if(window.psiqSuiteSqlPrevPage){window.psiqSuiteSqlPrevPage();}">Previous</button>',
      '<button type="button" onclick="if(window.psiqSuiteSqlNextPage){window.psiqSuiteSqlNextPage();}">Next</button>',
      '<button type="button" onclick="if(window.psiqSuiteSqlCopyResults){window.psiqSuiteSqlCopyResults();}">Copy Results</button>',
      '<span id="psiq-sql-page-status" class="psiq-sql-page-status"></span>',
      '</div>'
    ].join('');
  }

  function buildTableHtml(rows, sql) {
    if (!rows.length) {
      return '<div class="psiq-sql-empty">No rows returned.</div>';
    }

    const columns = getColumns(rows);
    const linkUrls = rows.map(row => getRecordUrl(row, sql));
    const showOpenColumn = linkUrls.some(Boolean);
    const header = columns
      .map(column => `<th>${escapeHtml(column)}</th>`)
      .join('');
    const body = rows.map((row, rowIndex) => {
      const openCell = showOpenColumn
        ? `<td>${buildOpenLinkHtml(linkUrls[rowIndex])}</td>`
        : '';
      const cells = columns
        .map(column => buildTableCellHtml(row[column], isNumericColumn(rows, column)))
        .join('');
      const searchText = columns
        .map(column => formatValue(row[column]))
        .join(' ');

      return `<tr data-psiq-row-index="${rowIndex}" data-psiq-search="${escapeAttr(searchText.toLowerCase())}">${openCell}${cells}</tr>`;
    }).join('');
    const openHeader = showOpenColumn ? '<th>open</th>' : '';

    return [
      '<div class="psiq-sql-table-wrap">',
      '<table id="psiq-sql-result-table" class="psiq-sql-table">',
      `<thead><tr>${openHeader}${header}</tr></thead>`,
      `<tbody>${body}</tbody>`,
      '</table>',
      '</div>'
    ].join('');
  }

  function buildTableCellHtml(value, isNumeric) {
    const cssClass = isNumeric ? ' class="psiq-sql-number"' : '';

    if (value === null || value === undefined) {
      return `<td${cssClass}><span class="psiq-sql-null">NULL</span></td>`;
    }

    const text = formatValue(value);

    if (text === '') {
      return `<td${cssClass}><span class="psiq-sql-empty-value">EMPTY</span></td>`;
    }

    return `<td${cssClass}><span class="psiq-sql-cell-text" title="${escapeAttr(text)}">${escapeHtml(text)}</span></td>`;
  }

  function buildOpenLinkHtml(url) {
    if (!url) {
      return '';
    }

    return `<a class="psiq-sql-open-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open</a>`;
  }

  function isNumericColumn(rows, column) {
    let foundValue = false;

    for (let i = 0; i < rows.length; i++) {
      const value = rows[i][column];

      if (value === null || value === undefined || value === '') {
        continue;
      }

      foundValue = true;

      if (!isNumericValue(value)) {
        return false;
      }
    }

    return foundValue;
  }

  function isNumericValue(value) {
    if (typeof value === 'number') {
      return true;
    }

    return /^-?\d+(\.\d+)?$/.test(String(value));
  }

  function getRecordUrl(row, sql) {
    const recordType = inferRecordType(row, sql);
    const id = getFirstValue(row, ['id', 'internalid', 'internal_id']);

    if (!recordType || !isNumericId(id)) {
      return '';
    }

    const encodedId = encodeURIComponent(String(id));

    if (recordType === 'transaction') {
      return `/app/accounting/transactions/transaction.nl?id=${encodedId}`;
    }

    if (recordType === 'item') {
      return `/app/common/item/item.nl?id=${encodedId}`;
    }

    if (recordType === 'vendor') {
      return `/app/common/entity/vendor.nl?id=${encodedId}`;
    }

    if (recordType === 'customer') {
      return `/app/common/entity/custjob.nl?id=${encodedId}`;
    }

    if (recordType === 'employee') {
      return `/app/common/entity/employee.nl?id=${encodedId}`;
    }

    return '';
  }

  function inferRecordType(row, sql) {
    const normalizedSql = String(sql || '').toLowerCase();
    const referencesTransaction = hasTableReference(normalizedSql, 'transaction');
    const referencesItem = hasTableReference(normalizedSql, 'item');
    const referencesVendor = hasTableReference(normalizedSql, 'vendor');
    const referencesCustomer = hasTableReference(normalizedSql, 'customer');
    const referencesEmployee = hasTableReference(normalizedSql, 'employee');

    if (row && (row.tranid || row.type)) {
      return 'transaction';
    }

    if (row && row.itemid) {
      return 'item';
    }

    if (referencesVendor && !referencesTransaction && !referencesItem) {
      return 'vendor';
    }

    if (referencesCustomer && !referencesTransaction && !referencesItem) {
      return 'customer';
    }

    if (referencesEmployee && !referencesTransaction && !referencesItem) {
      return 'employee';
    }

    if (referencesTransaction && !referencesItem && !referencesVendor && !referencesCustomer && !referencesEmployee) {
      return 'transaction';
    }

    if (referencesItem && !referencesTransaction && !referencesVendor && !referencesCustomer && !referencesEmployee) {
      return 'item';
    }

    return '';
  }

  function hasTableReference(sql, tableName) {
    const tablePattern = new RegExp(`\\b(from|join)\\s+${tableName}\\b`, 'i');

    return tablePattern.test(sql);
  }

  function getFirstValue(row, columnNames) {
    for (let i = 0; i < columnNames.length; i++) {
      if (Object.prototype.hasOwnProperty.call(row || {}, columnNames[i])) {
        return row[columnNames[i]];
      }
    }

    return '';
  }

  function isNumericId(value) {
    return /^\d+$/.test(String(value || ''));
  }

  function buildJsonHtml(rows) {
    return [
      '<details class="psiq-sql-json">',
      '<summary>Raw JSON</summary>',
      '<pre>',
      escapeHtml(JSON.stringify(rows, null, 2)),
      '</pre>',
      '</details>'
    ].join('');
  }

  function writeCsvResponse(ctx, rows) {
    ctx.response.addHeader({
      name: 'Content-Type',
      value: 'text/csv; charset=utf-8'
    });
    ctx.response.addHeader({
      name: 'Content-Disposition',
      value: 'attachment; filename="suiteql-results.csv"'
    });
    ctx.response.write(buildCsv(rows || []));
  }

  function buildCsv(rows) {
    if (!rows.length) {
      return '';
    }

    const columns = getColumns(rows);
    const header = columns.map(csvEscape).join(',');
    const body = rows
      .map(row => columns.map(column => csvEscape(row[column])).join(','))
      .join('\n');

    return `${header}\n${body}`;
  }

  function getColumns(rows) {
    const columns = {};

    rows.forEach(row => {
      Object.keys(row || {}).forEach(column => {
        columns[column] = true;
      });
    });

    return Object.keys(columns);
  }

  function csvEscape(value) {
    let text = formatValue(value);

    if (/^[=+\-@]/.test(text)) {
      text = `'${text}`;
    }

    return `"${text.replace(/"/g, '""')}"`;
  }

  function formatValue(value) {
    if (value === null || value === undefined) {
      return '';
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

  function getErrorText(error) {
    if (!error) {
      return 'Unknown error';
    }

    return error.message || error.name || String(error);
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value)
      .replace(/`/g, '&#96;');
  }

  function jsString(value) {
    return JSON.stringify(value)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  }

  return { onRequest };
});
