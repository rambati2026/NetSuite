/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define([
    'N/ui/serverWidget',
    'N/search',
    'N/url',
    'N/record',
    'N/log',
    'N/file',
    'N/runtime'
], (
    serverWidget,
    search,
    url,
    record,
    log,
    file,
    runtime
) => {

    const TXN_TYPES = {
        PURCHASE_ORDER: 'PurchOrd',
        ITEM_RECEIPT: 'ItemRcpt',
        VENDOR_BILL: 'VendBill',
        VENDOR_CREDIT: 'VendCred',
        BILL_PAYMENT: 'VendPymt'
    };

    const GUARDRAILS = {
        MAX_PO_RESULTS: 150,
        DIAGRAM_BATCH_SIZE: 10,
        LARGE_RESULT_WARNING_THRESHOLD: 75,
        FALLBACK_LINKAGE_PO_LIMIT: 25
    };

    function onRequest(context) {
        try {
            const request = context.request;
            const response = context.response;
            const action = String(request.parameters.action || '').toLowerCase();

            const options = {
                vendorId: request.parameters.custpage_vendor || request.parameters.vendor || '',
                poNumber: String(request.parameters.custpage_ponumber || request.parameters.ponumber || '').trim(),
                dateFrom: request.parameters.custpage_datefrom || request.parameters.datefrom || '',
                dateTo: request.parameters.custpage_dateto || request.parameters.dateto || '',
                showClosed: (request.parameters.custpage_showclosed || request.parameters.showclosed) === 'T'
            };

            if (action === 'csv') return handleCsvExport(context, options);
            if (action === 'sectionlist') return handleSectionList(context, options);

            const form = serverWidget.createForm({ title: 'Vendor Transaction Tree' });

            const vendorFld = form.addField({ id: 'custpage_vendor', type: serverWidget.FieldType.SELECT, label: 'Vendor', source: 'vendor' });
            const poNumberFld = form.addField({ id: 'custpage_ponumber', type: serverWidget.FieldType.TEXT, label: 'PO Number' });
            const dateFromFld = form.addField({ id: 'custpage_datefrom', type: serverWidget.FieldType.DATE, label: 'From Date' });
            const dateToFld = form.addField({ id: 'custpage_dateto', type: serverWidget.FieldType.DATE, label: 'To Date' });
            const showClosedFld = form.addField({ id: 'custpage_showclosed', type: serverWidget.FieldType.CHECKBOX, label: 'Show Closed / Paid Transactions' });

            poNumberFld.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });
            dateFromFld.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });
            dateToFld.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTROW });
            showClosedFld.updateBreakType({ breakType: serverWidget.FieldBreakType.STARTCOL });

            if (options.vendorId) vendorFld.defaultValue = options.vendorId;
            if (options.poNumber) poNumberFld.defaultValue = options.poNumber;
            if (options.dateFrom) dateFromFld.defaultValue = options.dateFrom;
            if (options.dateTo) dateToFld.defaultValue = options.dateTo;
            showClosedFld.defaultValue = options.showClosed ? 'T' : 'F';

            form.addSubmitButton({ label: 'Show Transactions' });

            const htmlFld = form.addField({ id: 'custpage_html', type: serverWidget.FieldType.INLINEHTML, label: ' ' });

            if (!options.vendorId && !options.poNumber) {
                htmlFld.defaultValue = '<div style="padding:16px;font-family:Arial,sans-serif;"><h3>Select Vendor or enter PO Number, then click "Show Transactions"</h3></div>';
                return response.writePage(form);
            }

            let poRoots = getPurchaseOrders(options);
            const originalPoCount = poRoots.length;
            let wasCapped = false;

            if (poRoots.length > GUARDRAILS.MAX_PO_RESULTS) {
                poRoots = poRoots.slice(0, GUARDRAILS.MAX_PO_RESULTS);
                wasCapped = true;
            }

            const treeData = buildTransactionTreeBulk(poRoots, options);

            let titleText = 'PO Search';
            if (options.vendorId) titleText = getVendorName(options.vendorId);
            else if (options.poNumber) titleText = 'PO ' + options.poNumber;

            htmlFld.defaultValue = buildHtml(treeData, titleText, options, {
                originalPoCount: originalPoCount,
                displayedPoCount: poRoots.length,
                wasCapped: wasCapped
            });

            response.writePage(form);
        } catch (e) {
            log.error('Suitelet Error', e);
            context.response.write(
                '<html><body style="font-family:Arial;padding:20px;">' +
                '<h3>Error</h3><pre>' + escapeHtml((e.name || 'ERROR') + ': ' + (e.message || e.toString())) + '</pre>' +
                '</body></html>'
            );
        }
    }

    function shouldIncludeTransaction(txn, options) {
        if (!options || options.showClosed) return true;

        const type = String(txn.type || '');
        const statusCode = String(txn.statusRefValue || '').toLowerCase();
        const statusText = String(txn.statusRefText || txn.status || '').toLowerCase();

        if (!statusCode && !statusText) return true;
        if (type === TXN_TYPES.PURCHASE_ORDER && (statusCode === 'closed' || statusCode === 'fullybilled' || statusCode === 'billed' || statusCode === 'purchord:g' || statusCode === 'purchord:h')) return false;
        if (type === TXN_TYPES.VENDOR_BILL && (statusCode === 'paidinfull' || statusCode === 'fullypaid' || statusCode === 'vendbill:c')) return false;
        if (type === TXN_TYPES.VENDOR_CREDIT && (statusCode === 'fullyapplied' || statusCode === 'applied' || statusCode === 'vendcred:b')) return false;
        if (type === TXN_TYPES.BILL_PAYMENT && (statusCode === 'fullyapplied' || statusCode === 'applied' || statusCode === 'vendpymt:c')) return false;
        if (type === TXN_TYPES.ITEM_RECEIPT && (statusCode === 'closed' || statusCode === 'itemrcpt:h')) return false;
        if (statusText.indexOf('closed') !== -1) return false;
        if (statusText.indexOf('fully billed') !== -1) return false;
        if (statusText.indexOf('paid in full') !== -1) return false;
        if (statusText.indexOf('fully applied') !== -1) return false;
        return true;
    }

    function handleCsvExport(context, options) {
        const poRoots = getPurchaseOrders(options).slice(0, GUARDRAILS.MAX_PO_RESULTS);
        const treeData = buildTransactionTreeBulk(poRoots, options);
        const rows = flattenTreeForCsv(treeData);
        const headers = ['PO Internal ID','PO Number','PO Date','PO Status','PO Amount','Level','Transaction Type','Transaction Number','Transaction Date','Transaction Status','Status Code','Status Text','Transaction Amount','Transaction Internal ID','Parent Transaction Number','Memo'];
        const csvLines = [headers.map(csvEscape).join(',')];
        rows.forEach(function (row) {
            csvLines.push([row.poId,row.poTranId,row.poDate,row.poStatus,row.poAmount,row.level,row.typeText,row.tranid,row.trandate,row.status,row.statusRefValue,row.statusRefText,row.amount,row.id,row.parentTranId,row.memo].map(csvEscape).join(','));
        });
        const csvFile = file.create({ name: 'vendor_transaction_tree.csv', fileType: file.Type.CSV, contents: csvLines.join('\n') });
        context.response.writeFile({ file: csvFile, isInline: false });
    }

    function handleSectionList(context, options) {
        const request = context.request;
        const poId = String(request.parameters.poid || '');
        const section = String(request.parameters.section || '').toLowerCase();
        const poRoots = getPurchaseOrders(options).slice(0, GUARDRAILS.MAX_PO_RESULTS);
        const treeData = buildTransactionTreeBulk(poRoots, options);
        const poNode = treeData.find(function (po) { return String(po.id) === poId; });

        if (!poNode) {
            return context.response.write('<html><body style="font-family:Arial;padding:20px;">PO not found.</body></html>');
        }

        let list = [];
        let title = '';
        if (section === 'receipts') {
            title = 'Receipts';
            list = poNode.children.filter(function (c) { return c.type === TXN_TYPES.ITEM_RECEIPT; });
        } else if (section === 'bills') {
            title = 'Bills';
            list = poNode.children.filter(function (c) { return c.type === TXN_TYPES.VENDOR_BILL; });
        } else if (section === 'credits') {
            title = 'Credits';
            list = poNode.children.filter(function (c) { return c.type === TXN_TYPES.VENDOR_CREDIT; });
        } else if (section === 'payments') {
            title = 'Payments';
            poNode.children.forEach(function (c) {
                if (c.type === TXN_TYPES.VENDOR_BILL && c.children && c.children.length) {
                    c.children.forEach(function (p) { list.push(p); });
                }
            });
        } else {
            title = 'Records';
        }

        const html = [];
        html.push('<html><head><title>' + escapeHtml(title) + '</title><style>' +
            'body{font-family:Arial,sans-serif;padding:18px;background:#f7f9fc;color:#0f172a}' +
            '.wrap{background:#fff;border:1px solid #dbe3ef;border-radius:14px;padding:18px;box-shadow:0 8px 24px rgba(15,23,42,0.06)}' +
            'table{width:100%;border-collapse:separate;border-spacing:0}' +
            'th,td{border-bottom:1px solid #e5e7eb;padding:10px 12px;text-align:left}' +
            'th{background:#f8fafc;position:sticky;top:0;z-index:2}' +
            'tbody tr:nth-child(even) td{background:#fbfdff}' +
            'tbody tr:hover td{background:#f3f7ff}' +
            'a{color:#0a58ca;text-decoration:none}a:hover{text-decoration:underline}.amt{text-align:right;font-variant-numeric:tabular-nums}' +
            '</style></head><body><div class="wrap"><h2 style="margin-top:0;">' + escapeHtml(title) + ' for ' + escapeHtml(poNode.tranid) + '</h2><table><thead><tr><th>Transaction</th><th>Type</th><th>Date</th><th>Status</th><th>Amount</th><th>Open</th></tr></thead><tbody>');

        if (!list.length) {
            html.push('<tr><td colspan="6">No records found.</td></tr>');
        } else {
            list.forEach(function (row) {
                html.push('<tr><td>' + escapeHtml(row.tranid || '') + '</td><td>' + escapeHtml(row.typeText || row.type || '') + '</td><td>' + escapeHtml(row.trandate || '') + '</td><td>' + escapeHtml(row.status || '') + '</td><td class="amt">' + formatAmount(row.amount) + '</td><td><a href="' + escapeHtml(getTransactionUrl(row.id, row.type)) + '" target="_blank">Open</a></td></tr>');
            });
        }

        html.push('</tbody></table></div></body></html>');
        context.response.write(html.join(''));
    }

    function buildTransactionTreeBulk(poRoots, options) {
        const poMap = {};
        const poIds = [];

        poRoots.forEach(function (po) {
            poMap[String(po.id)] = {
                id: po.id,
                type: po.type,
                typeText: po.typeText,
                tranid: po.tranid,
                trandate: po.trandate,
                status: po.status,
                statusRefValue: po.statusRefValue || '',
                statusRefText: po.statusRefText || '',
                amount: po.amount,
                memo: po.memo,
                entityText: po.entityText,
                children: []
            };
            poIds.push(String(po.id));
        });

        if (!poIds.length) return [];

        const directChildren = getChildTransactionsForPOs(poIds, options);
        const attachedDirectIds = {};
        const billIds = [];
        const billToPoMap = {};

        directChildren.forEach(function (child) {
            const poId = String(child.createdFrom || '');
            if (!poMap[poId]) return;
            const childNode = normalizeChild(child);
            poMap[poId].children.push(childNode);
            attachedDirectIds[String(child.id)] = true;
            if (child.type === TXN_TYPES.VENDOR_BILL) {
                billIds.push(String(child.id));
                billToPoMap[String(child.id)] = poId;
            }
        });

        const fallbackCandidates = poRoots.filter(function (po) {
            return !(poMap[String(po.id)].children || []).length;
        });

        if (fallbackCandidates.length && fallbackCandidates.length <= GUARDRAILS.FALLBACK_LINKAGE_PO_LIMIT) {
            const fallbackChildren = getFallbackLinkedTransactions(fallbackCandidates, options);
            fallbackChildren.forEach(function (child) {
                if (attachedDirectIds[String(child.id)]) return;
                const inferredPoId = inferPoIdFromFallback(child, fallbackCandidates);
                if (!inferredPoId || !poMap[inferredPoId]) return;
                const exists = poMap[inferredPoId].children.some(function (x) { return String(x.id) === String(child.id); });
                if (exists) return;
                const childNode = normalizeChild(child);
                poMap[inferredPoId].children.push(childNode);
                if (child.type === TXN_TYPES.VENDOR_BILL) {
                    billIds.push(String(child.id));
                    billToPoMap[String(child.id)] = inferredPoId;
                }
            });
        }

        const paymentsByBill = getBillPaymentsForBills(unique(billIds), options);
        Object.keys(paymentsByBill).forEach(function (billId) {
            const poId = billToPoMap[billId];
            if (!poId || !poMap[poId]) return;
            const billNode = poMap[poId].children.find(function (child) { return String(child.id) === String(billId); });
            if (!billNode) return;
            billNode.children = paymentsByBill[billId] || [];
            sortTree(billNode.children);
        });

        const roots = Object.keys(poMap).map(function (poId) {
            sortTree(poMap[poId].children);
            return poMap[poId];
        });

        // Latest PO first
        roots.sort(compareTxnDesc);

        return roots;
    }

    function normalizeChild(child) {
        return {
            id: child.id,
            type: child.type,
            typeText: child.typeText,
            tranid: child.tranid,
            trandate: child.trandate,
            status: child.status,
            statusRefValue: child.statusRefValue || '',
            statusRefText: child.statusRefText || '',
            amount: child.amount,
            memo: child.memo,
            createdFrom: child.createdFrom,
            children: []
        };
    }

    function getPurchaseOrders(options) {
        const rows = [];
        const filters = [['mainline', 'is', 'T'], 'AND', ['type', 'anyof', TXN_TYPES.PURCHASE_ORDER]];
        if (options.vendorId) { filters.push('AND'); filters.push(['entity', 'anyof', options.vendorId]); }
        if (options.poNumber) { filters.push('AND'); filters.push(['tranid', 'is', options.poNumber]); }
        if (options.dateFrom) { filters.push('AND'); filters.push(['trandate', 'onorafter', options.dateFrom]); }
        if (options.dateTo) { filters.push('AND'); filters.push(['trandate', 'onorbefore', options.dateTo]); }

        const poSearch = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'type' }),
                search.createColumn({ name: 'trandate', sort: search.Sort.DESC }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'statusref' }),
                search.createColumn({ name: 'amount' }),
                search.createColumn({ name: 'memo' }),
                search.createColumn({ name: 'entity' })
            ]
        });

        getAllResults(poSearch).forEach(function (result) {
            const row = {
                id: result.getValue({ name: 'internalid' }),
                type: result.getValue({ name: 'type' }),
                typeText: result.getText({ name: 'type' }) || '',
                tranid: result.getValue({ name: 'tranid' }) || '',
                trandate: result.getValue({ name: 'trandate' }) || '',
                status: result.getText({ name: 'statusref' }) || result.getValue({ name: 'statusref' }) || '',
                statusRefValue: String(result.getValue({ name: 'statusref' }) || ''),
                statusRefText: String(result.getText({ name: 'statusref' }) || ''),
                amount: result.getValue({ name: 'amount' }) || '',
                memo: result.getValue({ name: 'memo' }) || '',
                entityText: result.getText({ name: 'entity' }) || ''
            };
            if (shouldIncludeTransaction(row, options)) rows.push(row);
        });

        return rows;
    }

    function getChildTransactionsForPOs(poIds, options) {
        const rows = [];
        chunk(poIds, 1000).forEach(function (batch) {
            const filters = [
                ['mainline', 'is', 'T'],
                'AND', ['createdfrom', 'anyof', batch],
                'AND', ['type', 'anyof', TXN_TYPES.ITEM_RECEIPT, TXN_TYPES.VENDOR_BILL, TXN_TYPES.VENDOR_CREDIT]
            ];
            if (options.dateFrom) { filters.push('AND'); filters.push(['trandate', 'onorafter', options.dateFrom]); }
            if (options.dateTo) { filters.push('AND'); filters.push(['trandate', 'onorbefore', options.dateTo]); }

            const childSearch = search.create({
                type: search.Type.TRANSACTION,
                filters: filters,
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'type' }),
                    search.createColumn({ name: 'tranid', sort: search.Sort.ASC }),
                    search.createColumn({ name: 'trandate' }),
                    search.createColumn({ name: 'statusref' }),
                    search.createColumn({ name: 'amount' }),
                    search.createColumn({ name: 'memo' }),
                    search.createColumn({ name: 'createdfrom' })
                ]
            });

            getAllResults(childSearch).forEach(function (result) {
                const row = {
                    id: result.getValue({ name: 'internalid' }),
                    type: result.getValue({ name: 'type' }),
                    typeText: result.getText({ name: 'type' }) || '',
                    tranid: result.getValue({ name: 'tranid' }) || '',
                    trandate: result.getValue({ name: 'trandate' }) || '',
                    status: result.getText({ name: 'statusref' }) || result.getValue({ name: 'statusref' }) || '',
                    statusRefValue: String(result.getValue({ name: 'statusref' }) || ''),
                    statusRefText: String(result.getText({ name: 'statusref' }) || ''),
                    amount: result.getValue({ name: 'amount' }) || '',
                    memo: result.getValue({ name: 'memo' }) || '',
                    createdFrom: result.getValue({ name: 'createdfrom' }) || ''
                };
                if (shouldIncludeTransaction(row, options)) rows.push(row);
            });
        });
        return rows;
    }

    function getFallbackLinkedTransactions(poList, options) {
        const rows = [];
        const poTranIds = poList.map(function (po) { return String(po.tranid || '').trim(); }).filter(Boolean);
        if (!poTranIds.length) return rows;

        const vendorIds = unique(poList.map(function () { return String(options.vendorId || ''); }).filter(Boolean));
        const filters = [['mainline', 'is', 'T'], 'AND', ['type', 'anyof', TXN_TYPES.ITEM_RECEIPT, TXN_TYPES.VENDOR_BILL, TXN_TYPES.VENDOR_CREDIT]];
        if (vendorIds.length) { filters.push('AND'); filters.push(['entity', 'anyof', vendorIds]); }
        if (options.dateFrom) { filters.push('AND'); filters.push(['trandate', 'onorafter', options.dateFrom]); }
        if (options.dateTo) { filters.push('AND'); filters.push(['trandate', 'onorbefore', options.dateTo]); }

        const fallbackSearch = search.create({
            type: search.Type.TRANSACTION,
            filters: filters,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'type' }),
                search.createColumn({ name: 'tranid', sort: search.Sort.ASC }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'statusref' }),
                search.createColumn({ name: 'amount' }),
                search.createColumn({ name: 'memo' }),
                search.createColumn({ name: 'otherrefnum' }),
                search.createColumn({ name: 'createdfrom' })
            ]
        });

        const poIdSet = {};
        poList.forEach(function (po) { poIdSet[String(po.id)] = po; });

        getAllResults(fallbackSearch).forEach(function (result) {
            const memo = String(result.getValue({ name: 'memo' }) || '');
            const otherRef = String(result.getValue({ name: 'otherrefnum' }) || '');
            const tranid = String(result.getValue({ name: 'tranid' }) || '');
            const createdFrom = String(result.getValue({ name: 'createdfrom' }) || '');
            if (createdFrom && poIdSet[createdFrom]) return;
            const haystack = (memo + ' ' + otherRef + ' ' + tranid).toLowerCase();
            const matchedPo = poList.find(function (po) {
                const poNumber = String(po.tranid || '').toLowerCase();
                return poNumber && haystack.indexOf(poNumber) !== -1;
            });
            if (!matchedPo) return;

            const row = {
                id: result.getValue({ name: 'internalid' }),
                type: result.getValue({ name: 'type' }),
                typeText: result.getText({ name: 'type' }) || '',
                tranid: tranid,
                trandate: result.getValue({ name: 'trandate' }) || '',
                status: result.getText({ name: 'statusref' }) || result.getValue({ name: 'statusref' }) || '',
                statusRefValue: String(result.getValue({ name: 'statusref' }) || ''),
                statusRefText: String(result.getText({ name: 'statusref' }) || ''),
                amount: result.getValue({ name: 'amount' }) || '',
                memo: memo,
                createdFrom: String(matchedPo.id)
            };
            if (shouldIncludeTransaction(row, options)) rows.push(row);
        });

        return rows;
    }

    function inferPoIdFromFallback(child, poList) {
        if (child.createdFrom) return String(child.createdFrom);
        const haystack = String((child.memo || '') + ' ' + (child.tranid || '')).toLowerCase();
        const po = poList.find(function (p) {
            return String(p.tranid || '').toLowerCase() && haystack.indexOf(String(p.tranid || '').toLowerCase()) !== -1;
        });
        return po ? String(po.id) : '';
    }

    function getBillPaymentsForBills(billIds, options) {
        const paymentsByBill = {};
        if (!billIds || !billIds.length) return paymentsByBill;
        const billToPaymentIds = {};

        chunk(unique(billIds), 1000).forEach(function (batch) {
            const billSearch = search.create({
                type: search.Type.VENDOR_BILL,
                filters: [['internalid', 'anyof', batch], 'AND', ['mainline', 'is', 'T']],
                columns: [search.createColumn({ name: 'internalid' }), search.createColumn({ name: 'applyingtransaction' })]
            });
            getAllResults(billSearch).forEach(function (result) {
                const billId = String(result.getValue({ name: 'internalid' }) || '');
                const paymentId = String(result.getValue({ name: 'applyingtransaction' }) || '');
                if (!billId || !paymentId) return;
                if (!billToPaymentIds[billId]) billToPaymentIds[billId] = [];
                billToPaymentIds[billId].push(paymentId);
            });
        });

        const allPaymentIds = unique(Object.keys(billToPaymentIds).reduce(function (acc, billId) { return acc.concat(billToPaymentIds[billId]); }, []));
        if (!allPaymentIds.length) {
            Object.keys(billToPaymentIds).forEach(function (billId) { paymentsByBill[billId] = []; });
            return paymentsByBill;
        }

        const paymentMap = {};
        chunk(allPaymentIds, 1000).forEach(function (batch) {
            const txnSearch = search.create({
                type: search.Type.TRANSACTION,
                filters: [['mainline', 'is', 'T'], 'AND', ['internalid', 'anyof', batch]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'type' }),
                    search.createColumn({ name: 'tranid', sort: search.Sort.ASC }),
                    search.createColumn({ name: 'trandate' }),
                    search.createColumn({ name: 'statusref' }),
                    search.createColumn({ name: 'amount' }),
                    search.createColumn({ name: 'memo' })
                ]
            });
            getAllResults(txnSearch).forEach(function (result) {
                const row = {
                    id: result.getValue({ name: 'internalid' }),
                    type: result.getValue({ name: 'type' }),
                    typeText: result.getText({ name: 'type' }) || '',
                    tranid: result.getValue({ name: 'tranid' }) || '',
                    trandate: result.getValue({ name: 'trandate' }) || '',
                    status: result.getText({ name: 'statusref' }) || result.getValue({ name: 'statusref' }) || '',
                    statusRefValue: String(result.getValue({ name: 'statusref' }) || ''),
                    statusRefText: String(result.getText({ name: 'statusref' }) || ''),
                    amount: result.getValue({ name: 'amount' }) || '',
                    memo: result.getValue({ name: 'memo' }) || ''
                };
                if (row.type === TXN_TYPES.BILL_PAYMENT && shouldIncludeTransaction(row, options)) paymentMap[String(row.id)] = row;
            });
        });

        Object.keys(billToPaymentIds).forEach(function (billId) {
            paymentsByBill[billId] = (billToPaymentIds[billId] || []).map(function (paymentId) {
                return paymentMap[String(paymentId)];
            }).filter(Boolean).map(function (payment) {
                return {
                    id: payment.id,
                    type: payment.type,
                    typeText: payment.typeText,
                    tranid: payment.tranid,
                    trandate: payment.trandate,
                    status: payment.status,
                    statusRefValue: payment.statusRefValue || '',
                    statusRefText: payment.statusRefText || '',
                    amount: payment.amount,
                    memo: payment.memo,
                    children: []
                };
            });
        });

        return paymentsByBill;
    }

    function getAllResults(searchObj) {
        const results = [];
        const paged = searchObj.runPaged({ pageSize: 1000 });
        paged.pageRanges.forEach(function (range) {
            const page = paged.fetch({ index: range.index });
            page.data.forEach(function (row) { results.push(row); });
        });
        return results;
    }

    function unique(arr) {
        const seen = {};
        return (arr || []).filter(function (value) {
            if (!value || seen[value]) return false;
            seen[value] = true;
            return true;
        });
    }

    function getVendorName(vendorId) {
        try {
            const lookup = search.lookupFields({ type: search.Type.VENDOR, id: vendorId, columns: ['entityid', 'companyname'] });
            return lookup.companyname || lookup.entityid || ('Vendor #' + vendorId);
        } catch (e) {
            log.error('getVendorName', e);
            return 'Vendor #' + vendorId;
        }
    }

    function flattenTreeForCsv(treeData) {
        const rows = [];
        (treeData || []).forEach(function (po) {
            rows.push(makeCsvRow(po, po, 0, ''));
            (po.children || []).forEach(function (child) {
                rows.push(makeCsvRow(po, child, 1, po.tranid));
                (child.children || []).forEach(function (grandChild) {
                    rows.push(makeCsvRow(po, grandChild, 2, child.tranid));
                });
            });
        });
        return rows;
    }

    function makeCsvRow(po, node, level, parentTranId) {
        return {
            poId: po.id || '', poTranId: po.tranid || '', poDate: po.trandate || '', poStatus: po.status || '', poAmount: po.amount || '', level: level,
            typeText: node.typeText || node.type || '', tranid: node.tranid || '', trandate: node.trandate || '', status: node.status || '',
            statusRefValue: node.statusRefValue || '', statusRefText: node.statusRefText || '', amount: node.amount || '', id: node.id || '', parentTranId: parentTranId || '', memo: node.memo || ''
        };
    }

    function csvEscape(value) {
        const s = String(value === null || value === undefined ? '' : value);
        return '"' + s.replace(/"/g, '""') + '"';
    }

    function sortTree(nodes) {
        nodes.sort(compareTxn);
        nodes.forEach(function (node) {
            if (node.children && node.children.length) sortTree(node.children);
        });
    }

    // Children: oldest -> newest
    function compareTxn(a, b) {
        const dateA = safeDateValue(a.trandate);
        const dateB = safeDateValue(b.trandate);
        if (dateA !== dateB) return dateA - dateB;
        return String(a.tranid || '').localeCompare(String(b.tranid || ''));
    }

    // Root POs: newest -> oldest
    function compareTxnDesc(a, b) {
        const dateA = safeDateValue(a.trandate);
        const dateB = safeDateValue(b.trandate);
        if (dateA !== dateB) return dateB - dateA;
        return String(b.tranid || '').localeCompare(String(a.tranid || ''));
    }

    function safeDateValue(val) {
        if (!val) return 0;
        const d = new Date(val);
        const t = d.getTime();
        return isNaN(t) ? 0 : t;
    }

    function parseDateSafe(val) {
        if (!val) return null;
        const d = new Date(val);
        return isNaN(d.getTime()) ? null : d;
    }

    function daysBetweenToday(val) {
        const d = parseDateSafe(val);
        if (!d) return null;
        const now = new Date();
        return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    }

    function maxDateString(dateStrings) {
        let maxTime = null;
        let maxStr = '';
        (dateStrings || []).forEach(function (val) {
            const d = parseDateSafe(val);
            if (!d) return;
            const t = d.getTime();
            if (maxTime === null || t > maxTime) {
                maxTime = t;
                maxStr = val;
            }
        });
        return maxStr;
    }

    function chunk(arr, size) {
        const out = [];
        for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
        return out;
    }

    function toNumber(val) {
        const num = parseFloat(val);
        return isNaN(num) ? 0 : num;
    }

    function calcTotal(list) {
        let total = 0;
        (list || []).forEach(function (item) { total += toNumber(item.amount); });
        return total;
    }

    function determineSummaryStatus(poAmount, billsTotal, paymentsTotal, creditsTotal) {
        const tolerance = 0.01;
        const netBillExposure = billsTotal - creditsTotal;
        if (billsTotal > poAmount + tolerance) return 'danger';
        if (Math.abs(netBillExposure - paymentsTotal) <= tolerance && billsTotal <= poAmount + tolerance) return 'success';
        if (paymentsTotal + tolerance < billsTotal) return 'warning';
        return 'neutral';
    }

    function getStatusBadgeText(summaryStatus) {
        switch (summaryStatus) {
            case 'danger': return 'Over Billed';
            case 'warning': return 'Partially Paid';
            case 'success': return 'Reconciled';
            default: return 'Open';
        }
    }

    function buildGrandTotals(groupedData) {
        const totals = { poCount: 0, receiptCount: 0, billCount: 0, paymentCount: 0, creditCount: 0, poAmount: 0, receiptAmount: 0, billAmount: 0, paymentAmount: 0, creditAmount: 0, remainingExposure: 0 };
        (groupedData || []).forEach(function (po) {
            totals.poCount += 1;
            totals.poAmount += toNumber(po.summary ? po.summary.poAmount : 0);
            const receipts = po.sections && po.sections.receipts ? po.sections.receipts : [];
            const bills = po.sections && po.sections.bills ? po.sections.bills : [];
            const credits = po.sections && po.sections.credits ? po.sections.credits : [];
            totals.receiptCount += receipts.length;
            totals.billCount += bills.length;
            totals.creditCount += credits.length;
            totals.receiptAmount += calcTotal(receipts);
            totals.billAmount += calcTotal(bills);
            totals.creditAmount += calcTotal(credits);
            bills.forEach(function (bill) {
                const payments = bill.payments || [];
                totals.paymentCount += payments.length;
                totals.paymentAmount += calcTotal(payments);
            });
        });
        totals.remainingExposure = totals.poAmount - totals.billAmount + totals.creditAmount;
        return totals;
    }

    function buildExceptionSummary(groupedData) {
        const summary = { overBilled: 0, unpaid: 0, missingReceipt: 0, missingBill: 0, stale: 0, noRecentActivity: 0 };
        (groupedData || []).forEach(function (po) {
            const flags = po && po.analytics && po.analytics.exceptionFlags ? po.analytics.exceptionFlags : {};
            if (flags.overBilled) summary.overBilled += 1;
            if (flags.unpaidOrPartiallyPaid) summary.unpaid += 1;
            if (flags.billWithoutReceipt) summary.missingReceipt += 1;
            if (flags.receiptWithoutBill) summary.missingBill += 1;
            if (flags.staleOpenPo) summary.stale += 1;
            if (flags.noRecentActivity) summary.noRecentActivity += 1;
        });
        return summary;
    }

    function buildExceptionSummaryHtml(summary) {
        const items = [];
        function addItem(count, label, cls, filterKey) {
            items.push(
                '<button type="button" class="vt-ex-summary-card ' + cls + '" data-filter="' + escapeHtml(filterKey) + '">' +
                    '<div class="vt-ex-summary-count">' + escapeHtml(String(count)) + '</div>' +
                    '<div class="vt-ex-summary-label">' + escapeHtml(label) + '</div>' +
                '</button>'
            );
        }
        addItem(summary.overBilled, 'Overbilled', summary.overBilled ? 'danger' : 'neutral', 'overBilled');
        addItem(summary.unpaid, 'Unpaid / Partial', summary.unpaid ? 'warning' : 'neutral', 'unpaidPartial');
        addItem(summary.missingReceipt, 'Missing Receipt', summary.missingReceipt ? 'danger' : 'neutral', 'missingReceipt');
        addItem(summary.missingBill, 'Missing Bill', summary.missingBill ? 'warning' : 'neutral', 'missingBill');
        addItem(summary.stale, 'Open > 30 Days', summary.stale ? 'warning' : 'neutral', 'stale');
        addItem(summary.noRecentActivity, 'No Recent Activity', summary.noRecentActivity ? 'danger' : 'neutral', 'noRecentActivity');
        return '<div class="vt-ex-summary-wrap">' + items.join('') + '</div>';
    }

    function buildGroupedDiagramData(treeData) {
        return (treeData || []).map(function (poNode) {
            const grouped = { receipts: [], bills: [], credits: [], others: [] };
            const allDates = [poNode.trandate];
            let oldestOpenBillDate = '';

            (poNode.children || []).forEach(function (child) {
                allDates.push(child.trandate);
                if (child.type === TXN_TYPES.ITEM_RECEIPT) {
                    grouped.receipts.push(mapNodeForDiagram(child));
                } else if (child.type === TXN_TYPES.VENDOR_BILL) {
                    const billNode = mapNodeForDiagram(child);
                    billNode.payments = [];
                    let billPaymentTotal = 0;
                    (child.children || []).forEach(function (billChild) {
                        allDates.push(billChild.trandate);
                        if (billChild.type === TXN_TYPES.BILL_PAYMENT) {
                            billNode.payments.push(mapNodeForDiagram(billChild));
                            billPaymentTotal += Math.abs(toNumber(billChild.amount));
                        }
                    });
                    const billAmount = Math.abs(toNumber(child.amount));
                    if (billAmount - billPaymentTotal > 0.01 && (!oldestOpenBillDate || safeDateValue(child.trandate) < safeDateValue(oldestOpenBillDate))) {
                        oldestOpenBillDate = child.trandate;
                    }
                    grouped.bills.push(billNode);
                } else if (child.type === TXN_TYPES.VENDOR_CREDIT) {
                    grouped.credits.push(mapNodeForDiagram(child));
                } else {
                    grouped.others.push(mapNodeForDiagram(child));
                }
            });

            const poAmount = toNumber(poNode.amount);
            const receiptsTotal = calcTotal(grouped.receipts);
            const billsTotal = calcTotal(grouped.bills);
            const creditsTotal = calcTotal(grouped.credits);
            let paymentsTotal = 0;
            grouped.bills.forEach(function (bill) { paymentsTotal += calcTotal(bill.payments || []); });
            const absPaymentsTotal = Math.abs(paymentsTotal);
            const remainingBalance = poAmount - billsTotal + creditsTotal;
            const summaryStatus = determineSummaryStatus(poAmount, billsTotal, absPaymentsTotal, creditsTotal);
            const receiptCount = grouped.receipts.length;
            const billCount = grouped.bills.length;
            const creditCount = grouped.credits.length;
            const paymentCount = grouped.bills.reduce(function (acc, bill) { return acc + ((bill.payments || []).length); }, 0);
            const poAgeDays = daysBetweenToday(poNode.trandate);
            const lastActivityDate = maxDateString(allDates);
            const daysSinceLastActivity = daysBetweenToday(lastActivityDate);
            const oldestOpenBillAgeDays = daysBetweenToday(oldestOpenBillDate);

            const exceptionFlags = {
                overBilled: billsTotal > poAmount + 0.01,
                unpaidOrPartiallyPaid: absPaymentsTotal + 0.01 < billsTotal,
                billWithoutReceipt: billCount > 0 && receiptCount === 0,
                receiptWithoutBill: receiptCount > 0 && billCount === 0,
                staleOpenPo: remainingBalance > 0.01 && poAgeDays !== null && poAgeDays >= 30,
                noRecentActivity: remainingBalance > 0.01 && daysSinceLastActivity !== null && daysSinceLastActivity >= 30,
                agedUnpaidBill: absPaymentsTotal + 0.01 < billsTotal && oldestOpenBillAgeDays !== null && oldestOpenBillAgeDays >= 30
            };

            const exceptionCount = Object.keys(exceptionFlags).filter(function (k) { return !!exceptionFlags[k]; }).length;
            const agingBadges = [];
            if (poAgeDays !== null && poAgeDays >= 30 && remainingBalance > 0.01) agingBadges.push({ label: 'Open ' + poAgeDays + 'd', type: 'warning' });
            if (daysSinceLastActivity !== null && daysSinceLastActivity >= 30 && remainingBalance > 0.01) agingBadges.push({ label: 'No activity ' + daysSinceLastActivity + 'd', type: 'danger' });
            if (oldestOpenBillAgeDays !== null && oldestOpenBillAgeDays >= 30) agingBadges.push({ label: 'Unpaid bill ' + oldestOpenBillAgeDays + 'd', type: 'warning' });

            return {
                id: String(poNode.id || ''),
                tranid: poNode.tranid || '',
                type: poNode.type || '',
                typeText: poNode.typeText || '',
                trandate: poNode.trandate || '',
                status: poNode.status || '',
                statusRefValue: poNode.statusRefValue || '',
                statusRefText: poNode.statusRefText || '',
                amount: poNode.amount || '',
                memo: poNode.memo || '',
                url: getTransactionUrl(poNode.id, poNode.type),
                sections: grouped,
                analytics: {
                    receiptCount: receiptCount,
                    billCount: billCount,
                    paymentCount: paymentCount,
                    creditCount: creditCount,
                    poAgeDays: poAgeDays,
                    lastActivityDate: lastActivityDate || '',
                    daysSinceLastActivity: daysSinceLastActivity,
                    oldestOpenBillAgeDays: oldestOpenBillAgeDays,
                    exceptionFlags: exceptionFlags,
                    exceptionCount: exceptionCount,
                    agingBadges: agingBadges
                },
                summary: {
                    poAmount: poAmount,
                    receiptsTotal: receiptsTotal,
                    billsTotal: billsTotal,
                    paymentsTotal: absPaymentsTotal,
                    creditsTotal: creditsTotal,
                    remainingBalance: remainingBalance,
                    summaryStatus: summaryStatus,
                    statusBadgeText: getStatusBadgeText(summaryStatus),
                    billedPercent: poAmount > 0 ? Math.min((billsTotal / poAmount) * 100, 100) : 0,
                    paidPercent: billsTotal > 0 ? Math.min((absPaymentsTotal / billsTotal) * 100, 100) : 0
                }
            };
        });
    }

    function mapNodeForDiagram(node) {
        return {
            id: String(node.id || ''), tranid: node.tranid || '', type: node.type || '', typeText: node.typeText || '',
            trandate: node.trandate || '', status: node.status || '', statusRefValue: node.statusRefValue || '', statusRefText: node.statusRefText || '',
            amount: node.amount || '', memo: node.memo || '', url: getTransactionUrl(node.id, node.type)
        };
    }

    function buildSelfBaseUrl() {
        return url.resolveScript({ scriptId: runtime.getCurrentScript().id, deploymentId: runtime.getCurrentScript().deploymentId, returnExternalUrl: false });
    }

    function buildTableMeta(treeData) {
        const groupedData = buildGroupedDiagramData(treeData);
        const meta = {};
        groupedData.forEach(function (po) {
            const flags = (po.analytics && po.analytics.exceptionFlags) || {};
            meta[String(po.id)] = {
                poId: String(po.id),
                hasBills: po.analytics ? po.analytics.billCount > 0 : false,
                hasChildren: !!((po.sections && po.sections.receipts && po.sections.receipts.length) || (po.sections && po.sections.bills && po.sections.bills.length) || (po.sections && po.sections.credits && po.sections.credits.length) || (po.sections && po.sections.others && po.sections.others.length)),
                unpaidOrPartial: po.summary ? po.summary.summaryStatus === 'warning' : false,
                overBilled: po.summary ? po.summary.summaryStatus === 'danger' : false,
                reconciled: po.summary ? po.summary.summaryStatus === 'success' : false,
                hasException: !!(po.analytics && po.analytics.exceptionCount),
                exceptionCount: po.analytics && po.analytics.exceptionCount ? po.analytics.exceptionCount : 0,
                exceptionFlags: flags
            };
        });
        return meta;
    }

    function buildHtml(treeData, titleText, options, stats) {
        const rows = [];
        let counter = 0;
        const groupedData = buildGroupedDiagramData(treeData);
        const groupedDiagramData = JSON.stringify(groupedData);
        const grandTotals = buildGrandTotals(groupedData);
        const exceptionSummary = buildExceptionSummary(groupedData);
        const baseUrl = buildSelfBaseUrl();
        const tableMeta = JSON.stringify(buildTableMeta(treeData));

        const queryBase = [
            'custpage_vendor=' + encodeURIComponent(options.vendorId || ''),
            'custpage_ponumber=' + encodeURIComponent(options.poNumber || ''),
            'custpage_datefrom=' + encodeURIComponent(options.dateFrom || ''),
            'custpage_dateto=' + encodeURIComponent(options.dateTo || ''),
            'custpage_showclosed=' + (options.showClosed ? 'T' : 'F')
        ].join('&');

        const csvUrl = baseUrl + '&action=csv&' + queryBase;

        rows.push(`
            <div class="vt-wrap">
                <div class="vt-header">
                    <div><strong>Context:</strong> ${escapeHtml(titleText)}</div>
                    <div style="margin-top:6px;">
                        <strong>PO Filter:</strong> ${escapeHtml(options.poNumber || 'All')}
                        &nbsp; | &nbsp;
                        <strong>From:</strong> ${escapeHtml(options.dateFrom || 'All')}
                        &nbsp; | &nbsp;
                        <strong>To:</strong> ${escapeHtml(options.dateTo || 'All')}
                        &nbsp; | &nbsp;
                        <strong>Show Closed:</strong> ${options.showClosed ? 'Yes' : 'No'}
                    </div>
                </div>

                ${buildExceptionSummaryHtml(exceptionSummary)}

                ${stats.wasCapped ? `<div class="warning-banner">Showing first ${escapeHtml(String(stats.displayedPoCount))} POs out of ${escapeHtml(String(stats.originalPoCount))}. Refine filters to reduce volume.</div>` : ''}
                ${stats.originalPoCount >= GUARDRAILS.LARGE_RESULT_WARNING_THRESHOLD ? `<div class="warning-banner soft">Large result set detected. Diagram uses lazy rendering for performance.</div>` : ''}

                <div class="grand-totals-grid">
                    <div class="grand-total-box"><div class="grand-total-label">Total PO Count</div><div class="grand-total-value">${escapeHtml(String(grandTotals.poCount))}</div></div>
                    <div class="grand-total-box"><div class="grand-total-label">Total Receipts Count</div><div class="grand-total-value">${escapeHtml(String(grandTotals.receiptCount))}</div></div>
                    <div class="grand-total-box"><div class="grand-total-label">Total Bills Count</div><div class="grand-total-value">${escapeHtml(String(grandTotals.billCount))}</div></div>
                    <div class="grand-total-box"><div class="grand-total-label">Total Payments Count</div><div class="grand-total-value">${escapeHtml(String(grandTotals.paymentCount))}</div></div>
                    <div class="grand-total-box"><div class="grand-total-label">Total Credits Count</div><div class="grand-total-value">${escapeHtml(String(grandTotals.creditCount))}</div></div>
                    <div class="grand-total-box amount"><div class="grand-total-label">Total PO Amount</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.poAmount))}</div></div>
                    <div class="grand-total-box amount"><div class="grand-total-label">Total Receipt Amount</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.receiptAmount))}</div></div>
                    <div class="grand-total-box amount"><div class="grand-total-label">Total Bill Amount</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.billAmount))}</div></div>
                    <div class="grand-total-box amount"><div class="grand-total-label">Total Payment Amount</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.paymentAmount))}</div></div>
                    <div class="grand-total-box amount"><div class="grand-total-label">Total Credit Amount</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.creditAmount))}</div></div>
                    <div class="grand-total-box exposure"><div class="grand-total-label">Grand Remaining Exposure</div><div class="grand-total-value">${escapeHtml(formatAmount(grandTotals.remainingExposure))}</div></div>
                </div>

                <div class="filter-panel">
                    <div class="filter-title">Drill-down Filters</div>
                    <label><input type="checkbox" id="fltHasBills" onchange="applyDrillFilters()"> Only show POs with bills</label>
                    <label><input type="checkbox" id="fltUnpaidPartial" onchange="applyDrillFilters()"> Only show unpaid / partially paid</label>
                    <label><input type="checkbox" id="fltOverBilled" onchange="applyDrillFilters()"> Only show over-billed</label>
                    <label><input type="checkbox" id="fltReconciled" onchange="applyDrillFilters()"> Only show reconciled</label>
                    <label><input type="checkbox" id="fltExceptionOnly" onchange="applyDrillFilters()"> Exception mode only</label>
                    <label><input type="checkbox" id="fltHideNoChildren" onchange="applyDrillFilters()"> Hide POs with no child transactions</label>
                    <button type="button" class="vt-btn" onclick="resetDrillFilters()">Reset Filters</button>
                </div>

                <div class="vt-action-row">
                    <button type="button" class="vt-btn" onclick="showTableView()">Table View</button>
                    <button type="button" class="vt-btn" onclick="showDiagramView()">Diagram View</button>
                    <button type="button" class="vt-btn" onclick="openDiagramModal()">Open Diagram Modal</button>
                    <button type="button" class="vt-btn" onclick="vtExpandAll()">Expand All</button>
                    <button type="button" class="vt-btn" onclick="vtCollapseAll()">Collapse All</button>
                    <button type="button" class="vt-btn" onclick="refreshDiagram()">Refresh Diagram</button>
                    <a class="vt-btn vt-link-btn" href="${escapeHtml(csvUrl)}">Export CSV</a>
                </div>

                <div id="tableView">
                    <div class="vt-table-shell">
                        <table class="vt-table">
                            <thead>
                                <tr>
                                    <th style="width:42%;">Transaction</th>
                                    <th style="width:14%;">Type</th>
                                    <th style="width:12%;">Date</th>
                                    <th style="width:20%;">Status / %</th>
                                    <th style="width:8%;">Amount</th>
                                    <th style="width:4%;">View</th>
                                </tr>
                            </thead>
                            <tbody>
        `);

        treeData.forEach(function (node) {
            renderNode(node, 0, '', rows, function () { counter += 1; return counter; });
        });

        rows.push(`
                            </tbody>
                        </table>
                    </div>
                </div>

                <div id="diagramView" style="display:none;">
                    <div id="diagramCanvas" class="diagram-canvas"></div>
                    <div id="diagramLoadMoreWrap" class="diagram-load-more-wrap" style="display:none;">
                        <button type="button" class="vt-btn" onclick="loadMoreDiagram()">Load More</button>
                    </div>
                </div>
            </div>

            <div id="diagramModal" class="diagram-modal-backdrop" style="display:none;">
                <div class="diagram-modal-window">
                    <div class="diagram-modal-header">
                        <span class="diagram-modal-title">Transaction Analysis Workspace</span>
                        <div class="diagram-modal-actions">
                            <button type="button" class="vt-btn" onclick="renderDiagramInModal(true)">Refresh</button>
                            <button type="button" class="vt-btn vt-btn-danger" onclick="closeDiagramModal()">Close</button>
                        </div>
                    </div>
                    <div class="diagram-modal-body">
                        <div id="diagramModalCanvas" class="diagram-modal-canvas"></div>
                        <div id="diagramModalLoadMoreWrap" class="diagram-load-more-wrap" style="display:none;">
                            <button type="button" class="vt-btn" onclick="loadMoreDiagramModal()">Load More</button>
                        </div>
                    </div>
                </div>
            </div>
        `);

        return `
            <style>
                :root { --vt-border:#dbe3ef; --vt-border-soft:#e8eef6; --vt-text:#0f172a; }
                .vt-wrap { font-family:Arial,sans-serif; padding:8px 0 24px 0; color:var(--vt-text); }
                .vt-header { background:linear-gradient(180deg,#fbfcfe 0%,#f4f7fb 100%); border:1px solid var(--vt-border); border-radius:12px; padding:14px 16px; margin-bottom:10px; box-shadow:0 8px 24px rgba(15,23,42,0.04); }
                .vt-action-row { margin:10px 0 16px; display:flex; flex-wrap:wrap; gap:8px; }
                .vt-btn { background:#334155; color:#fff; border:none; border-radius:10px; padding:9px 13px; cursor:pointer; font-size:12px; text-decoration:none; display:inline-flex; align-items:center; }
                .vt-btn:hover { background:#1f2937; }
                .vt-btn-danger { background:#991b1b; }
                .vt-link-btn { color:#fff !important; }
                .warning-banner { background:#fff7ed; border:1px solid #fdba74; color:#9a3412; border-radius:10px; padding:10px 12px; margin-bottom:10px; font-size:13px; }
                .warning-banner.soft { background:#eff6ff; border-color:#93c5fd; color:#1e40af; }
                .vt-ex-summary-wrap { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin:0 0 12px 0; }
                .vt-ex-summary-card { background:#ffffff; border:1px solid var(--vt-border); border-radius:12px; padding:12px 14px; box-shadow:0 6px 18px rgba(15,23,42,0.04); text-align:left; cursor:pointer; transition:transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease; }
                .vt-ex-summary-card:hover { transform:translateY(-1px); box-shadow:0 10px 24px rgba(15,23,42,0.08); }
                .vt-ex-summary-card.is-active { outline:2px solid #334155; outline-offset:1px; }
                .vt-ex-summary-card.danger { background:#fff7f7; border-color:#fecaca; }
                .vt-ex-summary-card.warning { background:#fffbeb; border-color:#fde68a; }
                .vt-ex-summary-card.neutral { background:#f8fafc; border-color:#e2e8f0; }
                .vt-ex-summary-count { font-size:22px; line-height:1; font-weight:800; color:#0f172a; margin-bottom:6px; }
                .vt-ex-summary-card.danger .vt-ex-summary-count { color:#b91c1c; }
                .vt-ex-summary-card.warning .vt-ex-summary-count { color:#c2410c; }
                .vt-ex-summary-label { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:#64748b; font-weight:700; }
                .filter-panel { display:flex; flex-wrap:wrap; gap:14px 18px; align-items:center; background:#f8fafc; border:1px solid var(--vt-border); border-radius:12px; padding:12px; margin-bottom:12px; }
                .filter-panel .filter-title { font-size:13px; font-weight:bold; color:#24324a; margin-right:8px; }
                .filter-panel label { font-size:13px; color:#334155; display:inline-flex; align-items:center; gap:6px; }
                .vt-table-shell { border:1px solid var(--vt-border); border-radius:14px; overflow:auto; background:#fff; box-shadow:0 10px 30px rgba(15,23,42,0.06); max-height:720px; }
                .vt-table { width:100%; border-collapse:separate; border-spacing:0; font-size:13px; }
                .vt-table thead th { position:sticky; top:0; z-index:5; background:linear-gradient(180deg,#f8fafc 0%,#eef3f9 100%); color:#24324a; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; border-bottom:1px solid var(--vt-border); padding:12px 10px; }
                .vt-table tbody tr:nth-child(odd) td { background:#ffffff; }
                .vt-table tbody tr:nth-child(even) td { background:#f8fbff; }
                .vt-table tbody tr:hover td { background:#eef5ff; }
                .vt-row-alert-danger td { background:#fff1f2 !important; }
                .vt-row-alert-warning td { background:#fff7ed !important; }
                .vt-row-alert-success td { background:#ecfdf5 !important; }
                .vt-table td { border-bottom:1px solid var(--vt-border-soft); padding:10px 10px; vertical-align:top; }
                .vt-row-type-po td:first-child { box-shadow:inset 4px 0 0 #3b82f6; }
                .vt-row-type-receipt td:first-child { box-shadow:inset 4px 0 0 #10b981; }
                .vt-row-type-bill td:first-child { box-shadow:inset 4px 0 0 #f59e0b; }
                .vt-row-type-payment td:first-child { box-shadow:inset 4px 0 0 #8b5cf6; }
                .vt-row-type-credit td:first-child { box-shadow:inset 4px 0 0 #ef4444; }
                .vt-row-type-other td:first-child { box-shadow:inset 4px 0 0 #64748b; }
                .vt-tree-cell { white-space:nowrap; }
                .vt-indent { display:inline-block; }
                .vt-toggle { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:6px; cursor:pointer; font-weight:bold; color:#204a87; user-select:none; margin-right:6px; background:#edf4ff; border:1px solid #d3e2fb; }
                .vt-toggle:hover { background:#dbeafe; }
                .vt-toggle-placeholder { display:inline-block; width:18px; margin-right:6px; }
                .vt-link { color:#0a58ca; text-decoration:none; font-weight:600; }
                .vt-link:hover { text-decoration:underline; }
                .vt-muted { color:#64748b; margin-left:8px; font-size:12px; }
                .vt-pill { display:inline-block; padding:3px 8px; border:1px solid #cfd8ea; background:#f4f7fd; border-radius:999px; font-size:11px; margin-left:8px; color:#334155; }
                .vt-status-col { min-width:210px; }
                .vt-status-wrap { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:190px; }
                .vt-status-pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; border:1px solid transparent; }
                .vt-status-pill.danger { background:#fff1f2; color:#b91c1c; border-color:#fda4af; }
                .vt-status-pill.warning { background:#fff7ed; color:#c2410c; border-color:#fdba74; }
                .vt-status-pill.success { background:#ecfdf5; color:#15803d; border-color:#86efac; }
                .vt-status-pill.neutral { background:#eff6ff; color:#1d4ed8; border-color:#93c5fd; }
                .vt-status-metric { display:inline-flex; align-items:center; padding:4px 9px; border-radius:999px; font-size:11px; font-weight:700; color:#334155; background:#f8fafc; border:1px solid #dbe3ef; }
                .vt-inline-progress { flex-basis:100%; margin-top:2px; }
                .vt-inline-progress-track { width:120px; max-width:100%; height:6px; background:#e8eef6; border-radius:999px; overflow:hidden; border:1px solid #dbe3ef; }
                .vt-inline-progress-fill { height:100%; border-radius:999px; background:linear-gradient(90deg,#94a3b8 0%,#64748b 100%); }
                .vt-inline-progress-fill.over { background:linear-gradient(90deg,#f59e0b 0%,#ef4444 100%); }
                .vt-anomaly-wrap { display:inline-flex; align-items:center; gap:4px; margin-left:8px; vertical-align:middle; }
                .vt-anomaly-icon { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:999px; font-size:10px; font-weight:800; border:1px solid transparent; }
                .vt-anomaly-icon.danger { background:#fff1f2; color:#b91c1c; border-color:#fda4af; }
                .vt-anomaly-icon.warning { background:#fff7ed; color:#c2410c; border-color:#fdba74; }
                .vt-anomaly-icon.stale { background:#fef3c7; color:#92400e; border-color:#f59e0b; }
                .vt-anomaly-icon.info { background:#eff6ff; color:#1d4ed8; border-color:#93c5fd; }
                .vt-amount { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
                .vt-amount-main { font-weight:800; color:#0f172a; }
                .vt-amount-sub { margin-top:3px; font-size:11px; font-weight:700; }
                .vt-amount-positive { color:#475569; }
                .vt-amount-reconciled { color:#15803d; }
                .vt-amount-negative { color:#b91c1c; }
                .vt-center { text-align:center; }
                .vt-table-preview-anchor { position:relative; }
                .vt-table-hover-preview { position:absolute; left:calc(100% + 12px); top:0; width:260px; background:#ffffff; border:1px solid #dbe3ef; border-radius:12px; box-shadow:0 16px 36px rgba(15,23,42,0.14); padding:12px; z-index:25; display:none; }
                .vt-table-hover-preview.visible { display:block; }
                .vt-table-hover-title { font-size:12px; font-weight:800; color:#0f172a; margin-bottom:8px; }
                .vt-table-hover-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 10px; }
                .vt-table-hover-label { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:#94a3b8; font-weight:700; }
                .vt-table-hover-value { font-size:12px; color:#334155; font-weight:700; }
                .grand-totals-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; margin-bottom:12px; }
                .grand-total-box { background:#ffffff; border:1px solid var(--vt-border); border-radius:12px; padding:12px 14px; box-shadow:0 6px 20px rgba(15,23,42,0.04); }
                .grand-total-box.amount { background:#f8fafc; }
                .grand-total-box.exposure { background:#ecfeff; border-color:#99f6e4; }
                .grand-total-label { font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.4px; margin-bottom:4px; }
                .grand-total-value { font-size:22px; font-weight:bold; color:#0f172a; }
                .grand-total-box.exposure .grand-total-value { color:#0f766e; }
                .diagram-canvas, .diagram-modal-canvas { background:linear-gradient(180deg,#fbfcfe 0%,#f7f9fc 100%); border:1px solid var(--vt-border); border-radius:14px; padding:24px; overflow:auto; min-height:500px; }
                .diagram-load-more-wrap { text-align:center; margin-top:14px; }
                .diagram-po-root { margin-bottom:34px; padding:0 0 22px 0; border-bottom:1px solid #e5e7eb; }
                .diagram-po-card-wrap { display:flex; justify-content:flex-start; margin-bottom:16px; }
                .diagram-summary-bar { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-bottom:16px; }
                .diagram-summary-box { background:#ffffff; border:1px solid var(--vt-border); border-radius:12px; padding:12px 14px; }
                .diagram-summary-box.danger { background:#fff1f2; border-color:#fda4af; }
                .diagram-summary-box.warning { background:#fff7ed; border-color:#fdba74; }
                .diagram-summary-box.success { background:#ecfdf5; border-color:#86efac; }
                .diagram-summary-box.neutral { background:#ffffff; border-color:var(--vt-border); }
                .diagram-summary-label { font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.4em; margin-bottom:6px; }
                .diagram-summary-value { font-size:18px; font-weight:bold; color:#0f172a; }
                .diagram-summary-box.danger .diagram-summary-value { color:#b91c1c; }
                .diagram-summary-box.warning .diagram-summary-value { color:#c2410c; }
                .diagram-summary-box.success .diagram-summary-value { color:#15803d; }
                .diagram-summary-box.remaining .diagram-summary-value { color:#0f766e; }
                .diagram-progress-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; margin:0 0 18px 0; }
                .diagram-progress-card { background:#ffffff; border:1px solid var(--vt-border); border-radius:12px; padding:14px; box-shadow:0 6px 20px rgba(15,23,42,0.04); }
                .diagram-progress-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:8px; }
                .diagram-progress-label { font-size:12px; font-weight:700; color:#334155; }
                .diagram-progress-value { font-size:12px; font-weight:700; color:#0f172a; }
                .diagram-progress-track { position:relative; height:10px; border-radius:999px; background:#eaf0f7; overflow:hidden; }
                .diagram-progress-fill { position:absolute; left:0; top:0; bottom:0; border-radius:999px; }
                .diagram-progress-fill.billed { background:linear-gradient(90deg,#f59e0b 0%,#fbbf24 100%); }
                .diagram-progress-fill.paid { background:linear-gradient(90deg,#10b981 0%,#34d399 100%); }
                .diagram-progress-subtext { margin-top:8px; font-size:11px; color:#64748b; }
                .diagram-section-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); gap:18px; align-items:start; }
                .diagram-section { background:#ffffff; border:1px solid var(--vt-border); border-radius:14px; padding:14px; box-shadow:0 8px 24px rgba(15,23,42,0.04); }
                .diagram-section-title-row { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; padding-bottom:10px; border-bottom:1px solid #ecf0f6; }
                .diagram-section-title-block { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
                .diagram-section-title { font-weight:bold; font-size:13px; color:#24324a; }
                .diagram-section-total { font-size:12px; color:#475569; font-weight:bold; }
                .diagram-section-link { font-size:11px; color:#0a58ca; text-decoration:none; }
                .diagram-section-link:hover { text-decoration:underline; }
                .diagram-section-empty { color:#94a3b8; font-size:12px; font-style:italic; padding:10px 0; }
                .diagram-node-list { display:flex; flex-direction:column; gap:12px; }
                .diagram-bill-block { border:1px solid #e7ebf2; border-radius:14px; padding:14px; background:#fcfdff; }
                .diagram-payment-subsection { margin-top:14px; margin-left:10px; border-left:2px dashed #d6dbe5; padding-left:16px; }
                .diagram-payment-title-row { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; }
                .diagram-payment-title { font-size:12px; font-weight:bold; color:#4b5563; }
                .diagram-payment-total { font-size:12px; color:#475569; font-weight:bold; }
                .diagram-payment-toggle { font-size:11px; background:#eef2ff; border:1px solid #c7d2fe; color:#3730a3; border-radius:999px; padding:4px 10px; cursor:pointer; }
                .diagram-card-wrap { position:relative; display:block; }
                .diagram-card { min-width:240px; max-width:460px; background:#fff; border:1px solid #e5eaf3; border-radius:14px; box-shadow:0 10px 24px rgba(15,23,42,0.05); padding:16px 16px 14px 16px; cursor:pointer; transition:transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease; }
                .diagram-card:hover { transform:translateY(-1px); box-shadow:0 14px 28px rgba(15,23,42,0.08); border-color:#cbd5e1; }
                .diagram-card.po { border-left:5px solid #3b82f6; }
                .diagram-card.bill { border-left:5px solid #f59e0b; }
                .diagram-card.receipt { border-left:5px solid #10b981; }
                .diagram-card.payment { border-left:5px solid #8b5cf6; }
                .diagram-card.credit { border-left:5px solid #ef4444; }
                .diagram-card.other { border-left:5px solid #64748b; }
                .diagram-card-header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:start; margin-bottom:12px; }
                .diagram-title { font-weight:800; font-size:15px; color:#0f172a; margin-bottom:8px; line-height:1.2; }
                .diagram-type { display:inline-block; font-size:11px; padding:3px 9px; border-radius:999px; background:#f1f5f9; border:1px solid #e2e8f0; color:#334155; }
                .diagram-head-right { display:flex; flex-direction:column; align-items:flex-end; gap:8px; min-width:120px; }
                .diagram-primary-amount { font-size:19px; font-weight:800; color:#0f172a; text-align:right; font-variant-numeric:tabular-nums; }
                .diagram-status-badge { display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap; border:1px solid #dbe3ef; background:#f8fafc; color:#334155; }
                .diagram-meta { font-size:12px; color:#475569; line-height:1.6; }
                .diagram-meta-row { display:flex; justify-content:space-between; gap:12px; padding:2px 0; }
                .diagram-meta-label { color:#64748b; font-weight:600; }
                .diagram-meta-value { color:#0f172a; text-align:right; }
                .diagram-memo { margin-top:10px; padding-top:10px; border-top:1px dashed #e5e7eb; color:#64748b; font-size:11px; line-height:1.45; }
                .diagram-memo strong { color:#94a3b8; font-weight:700; }
                .diagram-hover-preview { position:absolute; left:calc(100% + 12px); top:0; width:300px; background:#ffffff; border:1px solid #dbe3ef; border-radius:14px; box-shadow:0 18px 40px rgba(15,23,42,0.16); padding:14px; z-index:30; display:none; }
                .diagram-hover-preview.visible { display:block; }
                .diagram-hover-title { font-size:13px; font-weight:800; color:#0f172a; margin-bottom:10px; }
                .diagram-hover-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px 12px; }
                .diagram-hover-item-label { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:#94a3b8; font-weight:700; }
                .diagram-hover-item-value { font-size:12px; color:#334155; font-weight:600; word-break:break-word; }
                .diagram-hover-memo { margin-top:10px; padding-top:10px; border-top:1px dashed #e5e7eb; font-size:11px; color:#64748b; line-height:1.45; }
                .diagram-hover-memo strong { color:#94a3b8; }
                .diagram-flag-row { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 14px; }
                .diagram-flag { display:inline-flex; align-items:center; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:700; border:1px solid transparent; }
                .diagram-flag.danger { background:#fff1f2; color:#b91c1c; border-color:#fda4af; }
                .diagram-flag.warning { background:#fff7ed; color:#c2410c; border-color:#fdba74; }
                .diagram-flag.success { background:#ecfdf5; color:#15803d; border-color:#86efac; }
                .diagram-flag.neutral { background:#eff6ff; color:#1d4ed8; border-color:#93c5fd; }
                .diagram-modal-backdrop { position:fixed; inset:0; background:rgba(2,6,23,0.62); backdrop-filter:blur(2px); z-index:9999; }
                .diagram-modal-window { position:absolute; top:3%; left:3%; width:94%; height:92%; background:#fff; border-radius:18px; overflow:hidden; box-shadow:0 30px 80px rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.08); }
                .diagram-modal-header { position:sticky; top:0; z-index:10; display:flex; justify-content:space-between; align-items:center; padding:18px 22px; background:linear-gradient(180deg,#f8fafc 0%,#eef2f7 100%); border-bottom:1px solid var(--vt-border); }
                .diagram-modal-title { font-size:24px; font-weight:800; letter-spacing:-0.01em; }
                .diagram-modal-actions { display:flex; align-items:center; gap:8px; }
                .diagram-modal-body { height:calc(100% - 74px); padding:18px; background:linear-gradient(180deg,#f8fafc 0%,#f4f7fb 100%); }
                .diagram-modal-canvas { height:calc(100% - 56px); border:1px solid #e2e8f0; border-radius:16px; min-height:unset; padding:28px; background:linear-gradient(180deg,#fcfdff 0%,#f7f9fc 100%); }
            </style>

            ${rows.join('')}

            <script>
                var groupedDiagramData = ${groupedDiagramData};
                var tableMetaByPoId = ${tableMeta};
                var diagramBatchSize = ${GUARDRAILS.DIAGRAM_BATCH_SIZE};
                var diagramRenderIndex = 0;
                var diagramModalRenderIndex = 0;
                var suiteletBaseUrl = ${JSON.stringify(baseUrl)};
                var suiteletQueryBase = ${JSON.stringify(queryBase)};

                function getDrillFilterState() {
                    return {
                        hasBills: !!document.getElementById('fltHasBills') && document.getElementById('fltHasBills').checked,
                        unpaidPartial: !!document.getElementById('fltUnpaidPartial') && document.getElementById('fltUnpaidPartial').checked,
                        overBilled: !!document.getElementById('fltOverBilled') && document.getElementById('fltOverBilled').checked,
                        reconciled: !!document.getElementById('fltReconciled') && document.getElementById('fltReconciled').checked,
                        exceptionOnly: !!document.getElementById('fltExceptionOnly') && document.getElementById('fltExceptionOnly').checked,
                        hideNoChildren: !!document.getElementById('fltHideNoChildren') && document.getElementById('fltHideNoChildren').checked
                    };
                }

                function clearExceptionSummaryActive() {
                    var cards = document.querySelectorAll('.vt-ex-summary-card.is-active');
                    for (var i = 0; i < cards.length; i++) cards[i].classList.remove('is-active');
                }

                function resetDrillFilters() {
                    ['fltHasBills','fltUnpaidPartial','fltOverBilled','fltReconciled','fltExceptionOnly','fltHideNoChildren'].forEach(function(id){
                        var el = document.getElementById(id);
                        if (el) el.checked = false;
                    });
                    clearExceptionSummaryActive();
                    applyDrillFilters();
                }

                function applyExceptionSummaryFilter(filterKey) {
                    clearExceptionSummaryActive();
                    ['fltHasBills','fltUnpaidPartial','fltOverBilled','fltReconciled','fltExceptionOnly','fltHideNoChildren'].forEach(function(id){
                        var el = document.getElementById(id);
                        if (el) el.checked = false;
                    });
                    if (filterKey === 'overBilled') {
                        var over = document.getElementById('fltOverBilled'); if (over) over.checked = true;
                    } else if (filterKey === 'unpaidPartial') {
                        var unpaid = document.getElementById('fltUnpaidPartial'); if (unpaid) unpaid.checked = true;
                    } else if (filterKey === 'missingReceipt' || filterKey === 'missingBill' || filterKey === 'stale' || filterKey === 'noRecentActivity') {
                        var exc = document.getElementById('fltExceptionOnly'); if (exc) exc.checked = true;
                    }
                    var active = document.querySelector('.vt-ex-summary-card[data-filter="' + filterKey + '"]');
                    if (active) active.classList.add('is-active');
                    applyDrillFilters();
                }

                function poMatchesFilters(meta, state) {
                    if (!meta) return true;
                    if (state.hasBills && !meta.hasBills) return false;
                    if (state.unpaidPartial && !meta.unpaidOrPartial) return false;
                    if (state.overBilled && !meta.overBilled) return false;
                    if (state.reconciled && !meta.reconciled) return false;
                    if (state.exceptionOnly && !meta.hasException) return false;
                    if (state.hideNoChildren && !meta.hasChildren) return false;
                    return true;
                }

                function applyDrillFilters() {
                    applyTableFilters();
                    refreshDiagram();
                }

                function applyTableFilters() {
                    var state = getDrillFilterState();
                    var rootRows = document.querySelectorAll('tr[data-level="0"]');
                    for (var i = 0; i < rootRows.length; i++) {
                        var row = rootRows[i];
                        var poId = row.getAttribute('data-poid');
                        var meta = tableMetaByPoId[poId];
                        var show = poMatchesFilters(meta, state);
                        row.style.display = show ? '' : 'none';
                        setChildRowsVisibility(row.getAttribute('data-node'), show);
                    }
                    syncAllToggleStates();
                }

                function setChildRowsVisibility(parentNodeId, parentVisible) {
                    var children = document.querySelectorAll('tr[data-parent="' + parentNodeId + '"]');
                    for (var i = 0; i < children.length; i++) {
                        children[i].style.display = parentVisible ? '' : 'none';
                        var childNodeId = children[i].getAttribute('data-node');
                        setChildRowsVisibility(childNodeId, parentVisible);
                    }
                }

                function vtToggle(nodeId) {
                    var row = document.querySelector('tr[data-node="' + nodeId + '"]');
                    if (row && row.getAttribute('data-level') === '0') {
                        var poId = row.getAttribute('data-poid');
                        var meta = tableMetaByPoId[poId];
                        if (!poMatchesFilters(meta, getDrillFilterState())) return;
                    }
                    var children = document.querySelectorAll('tr[data-parent="' + nodeId + '"]');
                    if (!children.length) return;
                    var expanded = false;
                    for (var i = 0; i < children.length; i++) {
                        if (children[i].style.display !== 'none') { expanded = true; break; }
                    }
                    if (expanded) {
                        vtHideChildren(nodeId);
                    } else {
                        for (var j = 0; j < children.length; j++) children[j].style.display = '';
                    }
                    syncToggleState(nodeId);
                }

                function vtHideChildren(nodeId) {
                    var children = document.querySelectorAll('tr[data-parent="' + nodeId + '"]');
                    for (var i = 0; i < children.length; i++) {
                        var childNodeId = children[i].getAttribute('data-node');
                        children[i].style.display = 'none';
                        var tg = document.querySelector('[data-toggle="' + childNodeId + '"]');
                        if (tg) tg.innerHTML = '+';
                        vtHideChildren(childNodeId);
                    }
                }

                function syncToggleState(nodeId) {
                    var tg = document.querySelector('[data-toggle="' + nodeId + '"]');
                    if (!tg) return;
                    var children = document.querySelectorAll('tr[data-parent="' + nodeId + '"]');
                    if (!children.length) return;
                    var anyVisible = false;
                    for (var i = 0; i < children.length; i++) {
                        if (children[i].style.display !== 'none') {
                            anyVisible = true;
                            break;
                        }
                    }
                    tg.innerHTML = anyVisible ? '-' : '+';
                }

                function syncAllToggleStates() {
                    var toggles = document.querySelectorAll('[data-toggle]');
                    for (var i = 0; i < toggles.length; i++) {
                        var nodeId = toggles[i].getAttribute('data-toggle');
                        if (nodeId) syncToggleState(nodeId);
                    }
                }

                function vtExpandAll() {
                    applyTableFilters();
                    var toggles = document.querySelectorAll('[data-toggle]');
                    for (var j = 0; j < toggles.length; j++) toggles[j].innerHTML = '-';
                    syncAllToggleStates();
                }

                function vtCollapseAll() {
                    var rows = document.querySelectorAll('tr[data-parent]');
                    for (var i = 0; i < rows.length; i++) rows[i].style.display = 'none';
                    var toggles = document.querySelectorAll('[data-toggle]');
                    for (var j = 0; j < toggles.length; j++) toggles[j].innerHTML = '+';
                    var rootRows = document.querySelectorAll('tr[data-level="0"]');
                    var state = getDrillFilterState();
                    for (var k = 0; k < rootRows.length; k++) {
                        var root = rootRows[k];
                        var poId = root.getAttribute('data-poid');
                        root.style.display = poMatchesFilters(tableMetaByPoId[poId], state) ? '' : 'none';
                    }
                    syncAllToggleStates();
                }

                function showTableView() {
                    var table = document.getElementById('tableView');
                    var diagram = document.getElementById('diagramView');
                    if (table) table.style.display = '';
                    if (diagram) diagram.style.display = 'none';
                    applyTableFilters();
                }

                function showDiagramView() {
                    var table = document.getElementById('tableView');
                    var diagram = document.getElementById('diagramView');
                    if (table) table.style.display = 'none';
                    if (diagram) diagram.style.display = '';
                    renderDiagram(true);
                }

                function refreshDiagram() {
                    var diagram = document.getElementById('diagramView');
                    if (diagram && diagram.style.display !== 'none') renderDiagram(true);
                    var modal = document.getElementById('diagramModal');
                    if (modal && modal.style.display !== 'none') renderDiagramInModal(true);
                }

                function openDiagramModal() {
                    var modal = document.getElementById('diagramModal');
                    if (!modal) return;
                    modal.style.display = 'block';
                    renderDiagramInModal(true);
                }

                function closeDiagramModal() {
                    var modal = document.getElementById('diagramModal');
                    if (!modal) return;
                    modal.style.display = 'none';
                }

                function renderDiagram(reset) {
                    renderIntoCanvas(document.getElementById('diagramCanvas'), document.getElementById('diagramLoadMoreWrap'), 'main', reset);
                }

                function renderDiagramInModal(reset) {
                    renderIntoCanvas(document.getElementById('diagramModalCanvas'), document.getElementById('diagramModalLoadMoreWrap'), 'modal', reset);
                }

                function filteredDiagramData() {
                    var state = getDrillFilterState();
                    return groupedDiagramData.filter(function(po){
                        var hasBills = po.sections && po.sections.bills && po.sections.bills.length > 0;
                        var hasChildren = !!((po.sections && po.sections.receipts && po.sections.receipts.length) || (po.sections && po.sections.bills && po.sections.bills.length) || (po.sections && po.sections.credits && po.sections.credits.length) || (po.sections && po.sections.others && po.sections.others.length));
                        var summaryStatus = po.summary ? po.summary.summaryStatus : 'neutral';
                        var hasException = !!(po.analytics && po.analytics.exceptionCount);
                        if (state.hasBills && !hasBills) return false;
                        if (state.unpaidPartial && summaryStatus !== 'warning') return false;
                        if (state.overBilled && summaryStatus !== 'danger') return false;
                        if (state.reconciled && summaryStatus !== 'success') return false;
                        if (state.exceptionOnly && !hasException) return false;
                        if (state.hideNoChildren && !hasChildren) return false;
                        return true;
                    });
                }

                function renderIntoCanvas(canvas, wrap, mode, reset) {
                    if (!canvas) return;
                    var visibleData = filteredDiagramData();
                    if (reset) {
                        canvas.innerHTML = '';
                        if (mode === 'main') diagramRenderIndex = 0;
                        if (mode === 'modal') diagramModalRenderIndex = 0;
                    }
                    if (!visibleData.length) {
                        canvas.innerHTML = '<div style="padding:20px;">No transactions found.</div>';
                        if (wrap) wrap.style.display = 'none';
                        return;
                    }
                    var start = mode === 'main' ? diagramRenderIndex : diagramModalRenderIndex;
                    var end = Math.min(start + diagramBatchSize, visibleData.length);
                    for (var i = start; i < end; i++) canvas.appendChild(renderGroupedPoDiagram(visibleData[i], getDrillFilterState()));
                    if (mode === 'main') diagramRenderIndex = end;
                    if (mode === 'modal') diagramModalRenderIndex = end;
                    if (wrap) wrap.style.display = end >= visibleData.length ? 'none' : '';
                }

                function loadMoreDiagram() { renderDiagram(false); }
                function loadMoreDiagramModal() { renderDiagramInModal(false); }
                function buildSectionUrl(poId, section) { return suiteletBaseUrl + '&action=sectionlist&poid=' + encodeURIComponent(poId) + '&section=' + encodeURIComponent(section) + '&' + suiteletQueryBase; }

                function renderPoFlags(po) {
                    var wrap = document.createElement('div'); wrap.className = 'diagram-flag-row';
                    var flags = (po.analytics && po.analytics.exceptionFlags) || {};
                    var agingBadges = (po.analytics && po.analytics.agingBadges) || [];
                    function addFlag(label, cls) { var el = document.createElement('span'); el.className = 'diagram-flag ' + cls; el.textContent = label; wrap.appendChild(el); }
                    if (flags.overBilled) addFlag('Over billed', 'danger');
                    if (flags.unpaidOrPartiallyPaid) addFlag('Unpaid / Partially paid', 'warning');
                    if (flags.billWithoutReceipt) addFlag('Bill without receipt', 'danger');
                    if (flags.receiptWithoutBill) addFlag('Receipt without bill', 'warning');
                    if (flags.staleOpenPo) addFlag('Open > 30 days', 'warning');
                    if (flags.noRecentActivity) addFlag('No recent activity', 'danger');
                    if (flags.agedUnpaidBill) addFlag('Aged unpaid bill', 'warning');
                    for (var i = 0; i < agingBadges.length; i++) addFlag(agingBadges[i].label, agingBadges[i].type || 'neutral');
                    if (!wrap.children.length) addFlag('No exceptions', 'success');
                    return wrap;
                }

                function renderGroupedPoDiagram(po, state) {
                    var root = document.createElement('div'); root.className = 'diagram-po-root'; root.setAttribute('data-poid', po.id);
                    var poWrap = document.createElement('div'); poWrap.className = 'diagram-po-card-wrap'; poWrap.appendChild(renderCard(po, null, po.summary.statusBadgeText)); root.appendChild(poWrap);
                    root.appendChild(renderPoFlags(po));
                    var summaryBar = document.createElement('div'); summaryBar.className = 'diagram-summary-bar';
                    summaryBar.appendChild(renderSummaryBox('PO Amount', po.summary.poAmount, 'neutral'));
                    summaryBar.appendChild(renderSummaryBox('Exception Count', (po.analytics && po.analytics.exceptionCount) || 0, ((po.analytics && po.analytics.exceptionCount) || 0) > 0 ? 'danger' : 'success'));
                    summaryBar.appendChild(renderSummaryBox('Receipts Total', po.summary.receiptsTotal, 'neutral'));
                    summaryBar.appendChild(renderSummaryBox('Bills Total', po.summary.billsTotal, po.summary.summaryStatus === 'danger' ? 'danger' : 'neutral'));
                    summaryBar.appendChild(renderSummaryBox('Payments Total', po.summary.paymentsTotal, po.summary.summaryStatus === 'warning' ? 'warning' : (po.summary.summaryStatus === 'success' ? 'success' : 'neutral')));
                    summaryBar.appendChild(renderSummaryBox('Credits Total', po.summary.creditsTotal, 'neutral'));
                    summaryBar.appendChild(renderSummaryBox('Remaining Balance', po.summary.remainingBalance, po.summary.summaryStatus === 'success' ? 'success' : (po.summary.summaryStatus === 'danger' ? 'danger' : 'neutral'), true));
                    root.appendChild(summaryBar);
                    var progressGrid = document.createElement('div'); progressGrid.className = 'diagram-progress-grid';
                    progressGrid.appendChild(renderProgressCard('Billed Progress', po.summary.billedPercent, po.summary.billsTotal, po.summary.poAmount, 'billed', 'Bills vs PO amount'));
                    progressGrid.appendChild(renderProgressCard('Paid Progress', po.summary.paidPercent, po.summary.paymentsTotal, po.summary.billsTotal, 'paid', 'Payments vs billed amount'));
                    root.appendChild(progressGrid);
                    var grid = document.createElement('div'); grid.className = 'diagram-section-grid';
                    var receipts = po.sections && po.sections.receipts ? po.sections.receipts : [];
                    var bills = po.sections && po.sections.bills ? po.sections.bills : [];
                    var credits = po.sections && po.sections.credits ? po.sections.credits : [];
                    var others = po.sections && po.sections.others ? po.sections.others : [];
                    grid.appendChild(renderSection('Receipts', receipts, 'receipt', po.summary.receiptsTotal, receipts.length, buildSectionUrl(po.id, 'receipts')));
                    grid.appendChild(renderBillSection('Bills', bills, po.summary.billsTotal, bills.length, buildSectionUrl(po.id, 'bills'), buildSectionUrl(po.id, 'payments')));
                    grid.appendChild(renderSection('Credits', credits, 'credit', po.summary.creditsTotal, credits.length, buildSectionUrl(po.id, 'credits')));
                    if (others.length) grid.appendChild(renderSection('Others', others, 'other', calcItemsTotal(others), others.length, '#'));
                    root.appendChild(grid);
                    return root;
                }

                function renderSummaryBox(label, value, statusClass, isRemaining) {
                    var box = document.createElement('div'); box.className = 'diagram-summary-box ' + (statusClass || 'neutral') + (isRemaining ? ' remaining' : '');
                    var lbl = document.createElement('div'); lbl.className = 'diagram-summary-label'; lbl.textContent = label;
                    var val = document.createElement('div'); val.className = 'diagram-summary-value'; val.textContent = formatAmt(value);
                    box.appendChild(lbl); box.appendChild(val); return box;
                }

                function renderProgressCard(label, percent, numerator, denominator, fillClass, subtext) {
                    var card = document.createElement('div'); card.className = 'diagram-progress-card';
                    var head = document.createElement('div'); head.className = 'diagram-progress-head';
                    var headLabel = document.createElement('div'); headLabel.className = 'diagram-progress-label'; headLabel.textContent = label;
                    var headValue = document.createElement('div'); headValue.className = 'diagram-progress-value'; headValue.textContent = Math.round(percent || 0) + '%';
                    head.appendChild(headLabel); head.appendChild(headValue);
                    var track = document.createElement('div'); track.className = 'diagram-progress-track';
                    var fill = document.createElement('div'); fill.className = 'diagram-progress-fill ' + fillClass; fill.style.width = Math.max(0, Math.min(percent || 0, 100)) + '%';
                    track.appendChild(fill);
                    var meta = document.createElement('div'); meta.className = 'diagram-progress-subtext'; meta.textContent = subtext + ': ' + formatAmt(numerator || 0) + ' / ' + formatAmt(denominator || 0);
                    card.appendChild(head); card.appendChild(track); card.appendChild(meta); return card;
                }

                function renderSection(title, items, cssType, totalValue, countValue, sectionUrl) {
                    var section = document.createElement('div'); section.className = 'diagram-section';
                    var headerRow = document.createElement('div'); headerRow.className = 'diagram-section-title-row';
                    var titleBlock = document.createElement('div'); titleBlock.className = 'diagram-section-title-block';
                    var header = document.createElement('div'); header.className = 'diagram-section-title'; header.textContent = title + ' (' + (countValue || 0) + ')'; titleBlock.appendChild(header);
                    if (sectionUrl && sectionUrl !== '#') { var link = document.createElement('a'); link.className = 'diagram-section-link'; link.href = sectionUrl; link.target = '_blank'; link.textContent = 'Open all'; titleBlock.appendChild(link); }
                    var total = document.createElement('div'); total.className = 'diagram-section-total'; total.textContent = 'Total: ' + formatAmt(totalValue || 0);
                    headerRow.appendChild(titleBlock); headerRow.appendChild(total); section.appendChild(headerRow);
                    if (!items || !items.length) { var empty = document.createElement('div'); empty.className = 'diagram-section-empty'; empty.textContent = 'No records'; section.appendChild(empty); return section; }
                    var list = document.createElement('div'); list.className = 'diagram-node-list';
                    for (var i = 0; i < items.length; i++) list.appendChild(renderCard(items[i], cssType));
                    section.appendChild(list); return section;
                }

                function renderBillSection(title, bills, totalValue, countValue, sectionUrl, paymentsUrl) {
                    var section = document.createElement('div'); section.className = 'diagram-section';
                    var headerRow = document.createElement('div'); headerRow.className = 'diagram-section-title-row';
                    var titleBlock = document.createElement('div'); titleBlock.className = 'diagram-section-title-block';
                    var header = document.createElement('div'); header.className = 'diagram-section-title'; header.textContent = title + ' (' + (countValue || 0) + ')'; titleBlock.appendChild(header);
                    if (sectionUrl && sectionUrl !== '#') { var link = document.createElement('a'); link.className = 'diagram-section-link'; link.href = sectionUrl; link.target = '_blank'; link.textContent = 'Open all'; titleBlock.appendChild(link); }
                    if (paymentsUrl && paymentsUrl !== '#') { var link2 = document.createElement('a'); link2.className = 'diagram-section-link'; link2.href = paymentsUrl; link2.target = '_blank'; link2.textContent = 'Open payments'; titleBlock.appendChild(link2); }
                    var total = document.createElement('div'); total.className = 'diagram-section-total'; total.textContent = 'Total: ' + formatAmt(totalValue || 0);
                    headerRow.appendChild(titleBlock); headerRow.appendChild(total); section.appendChild(headerRow);
                    if (!bills || !bills.length) { var empty = document.createElement('div'); empty.className = 'diagram-section-empty'; empty.textContent = 'No records'; section.appendChild(empty); return section; }
                    var list = document.createElement('div'); list.className = 'diagram-node-list';
                    for (var i = 0; i < bills.length; i++) {
                        var billBlock = document.createElement('div'); billBlock.className = 'diagram-bill-block'; billBlock.appendChild(renderCard(bills[i], 'bill'));
                        var payments = bills[i].payments || [];
                        var paymentWrap = document.createElement('div'); paymentWrap.className = 'diagram-payment-subsection';
                        var paymentHeaderRow = document.createElement('div'); paymentHeaderRow.className = 'diagram-payment-title-row';
                        var paymentTitle = document.createElement('div'); paymentTitle.className = 'diagram-payment-title'; paymentTitle.textContent = 'Payments (' + payments.length + ')';
                        var rightWrap = document.createElement('div'); rightWrap.style.display = 'flex'; rightWrap.style.alignItems = 'center'; rightWrap.style.gap = '8px';
                        var paymentTotal = document.createElement('div'); paymentTotal.className = 'diagram-payment-total'; paymentTotal.textContent = 'Total: ' + formatAmt(calcItemsTotal(payments));
                        var toggleBtn = document.createElement('button'); toggleBtn.type = 'button'; toggleBtn.className = 'diagram-payment-toggle'; toggleBtn.textContent = payments.length ? 'Hide' : 'No payments';
                        var paymentList = document.createElement('div'); paymentList.className = 'diagram-node-list';
                        if (!payments.length) {
                            var emptyPayment = document.createElement('div'); emptyPayment.className = 'diagram-section-empty'; emptyPayment.textContent = 'No records'; paymentList.appendChild(emptyPayment); toggleBtn.disabled = true;
                        } else {
                            for (var j = 0; j < payments.length; j++) paymentList.appendChild(renderCard(payments[j], 'payment'));
                            toggleBtn.onclick = (function (listEl, btnEl) { return function () { var hidden = listEl.style.display === 'none'; listEl.style.display = hidden ? '' : 'none'; btnEl.textContent = hidden ? 'Hide' : 'Show'; }; })(paymentList, toggleBtn);
                        }
                        rightWrap.appendChild(paymentTotal); rightWrap.appendChild(toggleBtn);
                        paymentHeaderRow.appendChild(paymentTitle); paymentHeaderRow.appendChild(rightWrap);
                        paymentWrap.appendChild(paymentHeaderRow); paymentWrap.appendChild(paymentList);
                        billBlock.appendChild(paymentWrap); list.appendChild(billBlock);
                    }
                    section.appendChild(list); return section;
                }

                function renderCard(node, forceType, badgeText) {
                    var visualType = forceType || node.type;
                    var wrap = document.createElement('div'); wrap.className = 'diagram-card-wrap';
                    var card = document.createElement('div'); card.className = 'diagram-card ' + getDiagramClass(visualType);
                    card.onclick = function () { if (node.url && node.url !== '#') window.open(node.url, '_blank'); };
                    var header = document.createElement('div'); header.className = 'diagram-card-header';
                    var left = document.createElement('div');
                    var title = document.createElement('div'); title.className = 'diagram-title'; title.textContent = node.tranid || ('Internal ID ' + node.id);
                    var type = document.createElement('div'); type.className = 'diagram-type'; type.textContent = getTypeLabel(visualType);
                    left.appendChild(title); left.appendChild(type);
                    var right = document.createElement('div'); right.className = 'diagram-head-right';
                    var amount = document.createElement('div'); amount.className = 'diagram-primary-amount'; amount.textContent = formatAmt(node.amount); right.appendChild(amount);
                    var statusPill = document.createElement('div'); statusPill.className = 'diagram-status-badge'; statusPill.textContent = badgeText || node.status || 'Open'; right.appendChild(statusPill);
                    header.appendChild(left); header.appendChild(right);
                    var meta = document.createElement('div'); meta.className = 'diagram-meta';
                    meta.innerHTML = '<div class="diagram-meta-row"><span class="diagram-meta-label">Date</span><span class="diagram-meta-value">' + safe(node.trandate) + '</span></div>' + '<div class="diagram-meta-row"><span class="diagram-meta-label">Status</span><span class="diagram-meta-value">' + safe(node.status) + '</span></div>';
                    card.appendChild(header); card.appendChild(meta);
                    if (node.memo) { var memo = document.createElement('div'); memo.className = 'diagram-memo'; memo.innerHTML = '<strong>Memo:</strong> ' + safe(node.memo); card.appendChild(memo); }
                    var preview = buildHoverPreview(node, visualType, badgeText || node.status || 'Open');
                    var hoverOpenTimer = null;
                    wrap.appendChild(card); wrap.appendChild(preview);
                    wrap.onmouseenter = function () { if (hoverOpenTimer) window.clearTimeout(hoverOpenTimer); hoverOpenTimer = window.setTimeout(function () { preview.classList.add('visible'); hoverOpenTimer = null; }, 200); };
                    wrap.onmouseleave = function () { if (hoverOpenTimer) { window.clearTimeout(hoverOpenTimer); hoverOpenTimer = null; } preview.classList.remove('visible'); };
                    return wrap;
                }

                function buildHoverPreview(node, visualType, badgeText) {
                    var preview = document.createElement('div'); preview.className = 'diagram-hover-preview';
                    var title = document.createElement('div'); title.className = 'diagram-hover-title'; title.textContent = (node.tranid || ('Internal ID ' + node.id)) + ' Quick View'; preview.appendChild(title);
                    var grid = document.createElement('div'); grid.className = 'diagram-hover-grid';
                    function addItem(label, value) {
                        var item = document.createElement('div');
                        var itemLabel = document.createElement('div'); itemLabel.className = 'diagram-hover-item-label'; itemLabel.textContent = label;
                        var itemValue = document.createElement('div'); itemValue.className = 'diagram-hover-item-value'; itemValue.textContent = value || '';
                        item.appendChild(itemLabel); item.appendChild(itemValue); grid.appendChild(item);
                    }
                    addItem('Type', getTypeLabel(visualType));
                    addItem('Status', badgeText || node.status || 'Open');
                    addItem('Date', node.trandate || '');
                    addItem('Amount', formatAmt(node.amount));
                    addItem('Internal ID', node.id || '');
                    addItem('Link', node.url && node.url !== '#' ? 'Available' : 'Unavailable');
                    preview.appendChild(grid);
                    if (node.memo) { var memo = document.createElement('div'); memo.className = 'diagram-hover-memo'; memo.innerHTML = '<strong>Memo:</strong> ' + safe(node.memo); preview.appendChild(memo); }
                    return preview;
                }

                function calcItemsTotal(items) { var total = 0; if (!items || !items.length) return total; for (var i = 0; i < items.length; i++) { var num = parseFloat(items[i].amount); if (!isNaN(num)) total += num; } return total; }
                function getDiagramClass(type) { if (type === 'PurchOrd' || type === 'po') return 'po'; if (type === 'VendBill' || type === 'bill') return 'bill'; if (type === 'ItemRcpt' || type === 'receipt') return 'receipt'; if (type === 'VendPymt' || type === 'payment') return 'payment'; if (type === 'VendCred' || type === 'credit') return 'credit'; return 'other'; }
                function getTypeLabel(type) { if (type === 'PurchOrd' || type === 'po') return 'Purchase Order'; if (type === 'VendBill' || type === 'bill') return 'Vendor Bill'; if (type === 'ItemRcpt' || type === 'receipt') return 'Item Receipt'; if (type === 'VendPymt' || type === 'payment') return 'Bill Payment'; if (type === 'VendCred' || type === 'credit') return 'Vendor Credit'; if (type === 'other') return 'Other'; return type || 'Transaction'; }
                function formatAmt(val) { if (val === null || val === undefined || val === '') return ''; var num = parseFloat(val); if (isNaN(num)) return String(val); return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
                function safe(v) { return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

                document.addEventListener('DOMContentLoaded', function () {
                    applyTableFilters();

                    document.addEventListener('mouseover', function (e) {
                        var anchor = e.target && e.target.closest ? e.target.closest('.vt-table-preview-anchor') : null;
                        if (!anchor) return;
                        var preview = anchor.querySelector('.vt-table-hover-preview');
                        if (!preview) return;
                        if (anchor._vtHoverTimer) window.clearTimeout(anchor._vtHoverTimer);
                        anchor._vtHoverTimer = window.setTimeout(function () {
                            preview.classList.add('visible');
                            anchor._vtHoverTimer = null;
                        }, 200);
                    });

                    document.addEventListener('mouseout', function (e) {
                        var anchor = e.target && e.target.closest ? e.target.closest('.vt-table-preview-anchor') : null;
                        if (!anchor) return;
                        var related = e.relatedTarget;
                        if (related && anchor.contains && anchor.contains(related)) return;
                        var preview = anchor.querySelector('.vt-table-hover-preview');
                        if (anchor._vtHoverTimer) {
                            window.clearTimeout(anchor._vtHoverTimer);
                            anchor._vtHoverTimer = null;
                        }
                        if (preview) preview.classList.remove('visible');
                    });

                    document.addEventListener('click', function (e) {
                        var card = e.target && e.target.closest ? e.target.closest('.vt-ex-summary-card[data-filter]') : null;
                        if (!card) return;
                        var filterKey = card.getAttribute('data-filter') || '';
                        if (!filterKey) return;
                        var wasActive = card.classList.contains('is-active');
                        if (wasActive) {
                            resetDrillFilters();
                            return;
                        }
                        applyExceptionSummaryFilter(filterKey);
                    });
                });
            </script>
        `;
    }

    function renderNode(node, level, parentNodeId, rows, nextId) {
        const nodeId = 'vt_node_' + nextId();
        const hasChildren = node.children && node.children.length > 0;
        const poId = level === 0 ? String(node.id || '') : '';
        const rowTypeClass = 'vt-row-type-' + getTypeCssClass(node.type);
        const alertClass = level === 0 ? getRowAlertClass(node) : '';
        const trAttrs = [];
        trAttrs.push(`data-node="${escapeHtml(nodeId)}"`);
        trAttrs.push(`data-level="${level}"`);
        trAttrs.push(`class="${escapeHtml((rowTypeClass + ' ' + alertClass).trim())}"`);
        if (level === 0) trAttrs.push(`data-poid="${escapeHtml(poId)}"`);
        if (parentNodeId) {
            trAttrs.push(`data-parent="${escapeHtml(parentNodeId)}"`);
            trAttrs.push('style="display:none;"');
        }

        rows.push(`
            <tr ${trAttrs.join(' ')}>
                <td class="vt-tree-cell">${buildTreeCell(node, level, hasChildren, nodeId)}</td>
                <td>${escapeHtml(node.typeText || node.type || '')}</td>
                <td>${escapeHtml(node.trandate || '')}</td>
                <td class="vt-status-col">${buildStatusCell(node)}</td>
                <td class="vt-amount ${buildAmountClass(node, level)}">${buildAmountCell(node, level)}</td>
                <td class="vt-center"><a class="vt-link" href="${escapeHtml(getTransactionUrl(node.id, node.type))}" target="_blank">Open</a></td>
            </tr>
        `);

        if (hasChildren) {
            node.children.forEach(function (child) { renderNode(child, level + 1, nodeId, rows, nextId); });
        }
    }

    function buildTreeCell(node, level, hasChildren, nodeId) {
        const indent = `<span class="vt-indent" style="width:${level * 22}px;"></span>`;
        const toggle = hasChildren ? `<span class="vt-toggle" data-toggle="${escapeHtml(nodeId)}" onclick="vtToggle('${escapeJs(nodeId)}')">+</span>` : '<span class="vt-toggle-placeholder"></span>';
        const label = escapeHtml(node.tranid || ('Internal ID ' + node.id));
        const extra = [];
        if (node.memo) extra.push(escapeHtml(node.memo));
        const anomalyIcons = level === 0 ? buildAnomalyIcons(node) : '';
        const previewHtml = level === 0 ? buildTableHoverPreview(node) : '';
        return indent + toggle + `<span class="vt-table-preview-anchor"><a class="vt-link" href="${escapeHtml(getTransactionUrl(node.id, node.type))}" target="_blank">${label}</a>${previewHtml}</span>` + `<span class="vt-pill">${escapeHtml(getTypeBadge(node.type))}</span>` + anomalyIcons + (extra.length ? `<span class="vt-muted">- ${extra.join(' | ')}</span>` : '');
    }

    function buildAnomalyIcons(node) {
        if (!node || node.type !== TXN_TYPES.PURCHASE_ORDER) return '';
        const breakdown = getPoFinancialBreakdown(node);
        const ageDays = daysBetweenToday(node.trandate);
        const icons = [];
        if (breakdown.overBilled) icons.push('<span class="vt-anomaly-icon danger" title="Over billed">!</span>');
        if (breakdown.unpaidBillCount > 0) icons.push('<span class="vt-anomaly-icon warning" title="Unpaid bill exists">$</span>');
        if (ageDays !== null && ageDays >= 30 && breakdown.remaining > 0.01) icons.push('<span class="vt-anomaly-icon stale" title="Open PO older than 30 days">C</span>');
        if (breakdown.billWithoutReceipt) icons.push('<span class="vt-anomaly-icon danger" title="Bill without receipt">B</span>');
        if (breakdown.receiptWithoutBill) icons.push('<span class="vt-anomaly-icon info" title="Receipt without bill">R</span>');
        return icons.length ? `<span class="vt-anomaly-wrap">${icons.join('')}</span>` : '';
    }

    function getPoFinancialBreakdown(node) {
        const poAmount = Math.abs(toNumber(node && node.amount));
        let billsTotal = 0;
        let paymentsTotal = 0;
        let creditsTotal = 0;
        let receiptCount = 0;
        let billCount = 0;
        let paymentCount = 0;
        let unpaidBillCount = 0;
        const allDates = [];
        if (node && node.trandate) allDates.push(node.trandate);
        (node && node.children || []).forEach(function (child) {
            if (child.trandate) allDates.push(child.trandate);
            if (child.type === TXN_TYPES.ITEM_RECEIPT) receiptCount += 1;
            if (child.type === TXN_TYPES.VENDOR_CREDIT) creditsTotal += Math.abs(toNumber(child.amount));
            if (child.type === TXN_TYPES.VENDOR_BILL) {
                billCount += 1;
                const billAmt = Math.abs(toNumber(child.amount));
                billsTotal += billAmt;
                let billPaid = 0;
                (child.children || []).forEach(function (payment) {
                    if (payment.trandate) allDates.push(payment.trandate);
                    if (payment.type === TXN_TYPES.BILL_PAYMENT) {
                        billPaid += Math.abs(toNumber(payment.amount));
                        paymentsTotal += Math.abs(toNumber(payment.amount));
                        paymentCount += 1;
                    }
                });
                if (billPaid + 0.01 < billAmt) unpaidBillCount += 1;
            }
        });
        const billedNet = Math.max(0, billsTotal - creditsTotal);
        return {
            poAmount: poAmount,
            billsTotal: billsTotal,
            paymentsTotal: paymentsTotal,
            creditsTotal: creditsTotal,
            billedNet: billedNet,
            remaining: poAmount - billsTotal + creditsTotal,
            receiptCount: receiptCount,
            billCount: billCount,
            paymentCount: paymentCount,
            unpaidBillCount: unpaidBillCount,
            overBilled: billsTotal > poAmount + 0.01,
            receiptWithoutBill: receiptCount > 0 && billCount === 0,
            billWithoutReceipt: billCount > 0 && receiptCount === 0,
            lastActivityDate: maxDateString(allDates)
        };
    }

    function getRowAlertClass(node) {
        if (!node || node.type !== TXN_TYPES.PURCHASE_ORDER) return '';
        const info = getPoFinancialBreakdown(node);
        const remaining = info.remaining;
        if (remaining < -0.01 || info.overBilled) return 'vt-row-alert-danger';
        if (info.unpaidBillCount > 0) return 'vt-row-alert-warning';
        if (Math.abs(remaining) <= 0.01 && info.billCount > 0) return 'vt-row-alert-success';
        return '';
    }

    function buildTableHoverPreview(node) {
        if (!node || node.type !== TXN_TYPES.PURCHASE_ORDER) return '';
        const info = getPoFinancialBreakdown(node);
        return `<div class="vt-table-hover-preview"><div class="vt-table-hover-title">Quick View</div><div class="vt-table-hover-grid"><div><div class="vt-table-hover-label">Bills</div><div class="vt-table-hover-value">${escapeHtml(String(info.billCount || 0))}</div></div><div><div class="vt-table-hover-label">Payments</div><div class="vt-table-hover-value">${escapeHtml(String(info.paymentCount || 0))}</div></div><div><div class="vt-table-hover-label">Remaining</div><div class="vt-table-hover-value">${escapeHtml(formatAmount(info.remaining))}</div></div><div><div class="vt-table-hover-label">Last Activity</div><div class="vt-table-hover-value">${escapeHtml(info.lastActivityDate || '-')}</div></div></div></div>`;
    }

    function getTypeBadge(type) {
        switch (type) {
            case TXN_TYPES.PURCHASE_ORDER: return 'PO';
            case TXN_TYPES.ITEM_RECEIPT: return 'Receipt';
            case TXN_TYPES.VENDOR_BILL: return 'Bill';
            case TXN_TYPES.VENDOR_CREDIT: return 'Credit';
            case TXN_TYPES.BILL_PAYMENT: return 'Payment';
            default: return type || '';
        }
    }

    function getTypeCssClass(type) {
        switch (type) {
            case TXN_TYPES.PURCHASE_ORDER: return 'po';
            case TXN_TYPES.ITEM_RECEIPT: return 'receipt';
            case TXN_TYPES.VENDOR_BILL: return 'bill';
            case TXN_TYPES.VENDOR_CREDIT: return 'credit';
            case TXN_TYPES.BILL_PAYMENT: return 'payment';
            default: return 'other';
        }
    }

    function getStatusClass(status, statusRefValue, type) {
        const code = String(statusRefValue || '').toLowerCase();
        const text = String(status || '').toLowerCase();
        if (type === TXN_TYPES.PURCHASE_ORDER) {
            if (code === 'closed' || code === 'fullybilled' || code === 'billed' || code === 'purchord:g' || code === 'purchord:h' || text.indexOf('fully billed') !== -1) return 'danger';
            if (text.indexOf('pending') !== -1 || text.indexOf('partially') !== -1) return 'warning';
            return 'neutral';
        }
        if (type === TXN_TYPES.VENDOR_BILL) {
            if (code === 'paidinfull' || code === 'fullypaid' || code === 'vendbill:c' || text.indexOf('paid in full') !== -1) return 'success';
            if (text.indexOf('open') !== -1 || text.indexOf('pending') !== -1 || text.indexOf('partially') !== -1) return 'warning';
            return 'neutral';
        }
        if (type === TXN_TYPES.BILL_PAYMENT) return 'success';
        if (type === TXN_TYPES.ITEM_RECEIPT) return 'success';
        if (type === TXN_TYPES.VENDOR_CREDIT) return 'danger';
        return 'neutral';
    }

    function buildStatusPill(status, statusRefValue, type) {
        const cls = getStatusClass(status, statusRefValue, type);
        return `<span class="vt-status-pill ${escapeHtml(cls)}">${escapeHtml(status || 'Open')}</span>`;
    }

    function getPoBilledPercent(node) {
        if (!node || node.type !== TXN_TYPES.PURCHASE_ORDER) return null;
        const poAmount = toNumber(node.amount);
        if (poAmount <= 0) return null;
        let billsTotal = 0;
        (node.children || []).forEach(function (child) {
            if (child.type === TXN_TYPES.VENDOR_BILL) billsTotal += Math.abs(toNumber(child.amount));
        });
        const pct = Math.min((billsTotal / poAmount) * 100, 999.9);
        return isNaN(pct) ? null : pct;
    }

    function buildStatusCell(node) {
        const parts = [buildStatusPill(node.status, node.statusRefValue, node.type)];
        const billedPct = getPoBilledPercent(node);
        if (billedPct !== null) {
            const safePct = Math.max(0, Math.min(billedPct, 100));
            parts.push(`<span class="vt-status-metric">Billed ${escapeHtml(billedPct.toFixed(1))}%</span><div class="vt-inline-progress" aria-label="Billed percentage"><div class="vt-inline-progress-track"><div class="vt-inline-progress-fill ${billedPct > 100 ? 'over' : ''}" style="width:${escapeHtml(String(safePct))}%;"></div></div></div>`);
        }
        return `<div class="vt-status-wrap">${parts.join('')}</div>`;
    }

    function getPoRemainingBalance(node) {
        if (!node || node.type !== TXN_TYPES.PURCHASE_ORDER) return null;
        const poAmount = toNumber(node.amount);
        let billsTotal = 0;
        let creditsTotal = 0;
        (node.children || []).forEach(function (child) {
            if (child.type === TXN_TYPES.VENDOR_BILL) billsTotal += Math.abs(toNumber(child.amount));
            else if (child.type === TXN_TYPES.VENDOR_CREDIT) creditsTotal += Math.abs(toNumber(child.amount));
        });
        return poAmount - billsTotal + creditsTotal;
    }

    function buildAmountClass(node, level) {
        if (level !== 0 || !node || node.type !== TXN_TYPES.PURCHASE_ORDER) return '';
        const remaining = getPoRemainingBalance(node);
        if (remaining === null) return '';
        if (remaining < -0.01) return 'vt-amount-negative';
        if (Math.abs(remaining) <= 0.01) return 'vt-amount-reconciled';
        return 'vt-amount-positive';
    }

    function buildAmountCell(node, level) {
        const mainAmount = formatAmount(node.amount);
        if (level !== 0 || !node || node.type !== TXN_TYPES.PURCHASE_ORDER) return mainAmount;
        const remaining = getPoRemainingBalance(node);
        if (remaining === null) return mainAmount;
        let toneLabel = 'Remaining';
        if (remaining < -0.01) toneLabel = 'Overbilled';
        else if (Math.abs(remaining) <= 0.01) toneLabel = 'Reconciled';
        return `<div class="vt-amount-main">${mainAmount}</div><div class="vt-amount-sub ${buildAmountClass(node, level)}">${escapeHtml(toneLabel)}: ${escapeHtml(formatAmount(remaining))}</div>`;
    }

    function getTransactionUrl(id, type) {
        try {
            return url.resolveRecord({ recordType: mapRecordType(type), recordId: id, isEditMode: false });
        } catch (e) {
            log.debug('getTransactionUrl failed', { id: id, type: type, error: e });
            return '#';
        }
    }

    function mapRecordType(type) {
        switch (type) {
            case TXN_TYPES.PURCHASE_ORDER: return record.Type.PURCHASE_ORDER;
            case TXN_TYPES.ITEM_RECEIPT: return record.Type.ITEM_RECEIPT;
            case TXN_TYPES.VENDOR_BILL: return record.Type.VENDOR_BILL;
            case TXN_TYPES.VENDOR_CREDIT: return record.Type.VENDOR_CREDIT;
            case TXN_TYPES.BILL_PAYMENT: return record.Type.VENDOR_PAYMENT;
            default: return record.Type.PURCHASE_ORDER;
        }
    }

    function formatAmount(val) {
        if (val === null || val === undefined || val === '') return '';
        const num = parseFloat(val);
        if (isNaN(num)) return escapeHtml(String(val));
        return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function escapeHtml(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeJs(str) {
        return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
    }

    return { onRequest: onRequest };
});