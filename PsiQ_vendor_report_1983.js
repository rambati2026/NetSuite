/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */

define(['N/search', 'N/file', 'N/email', 'N/runtime', 'N/record'],
(search, file, email, runtime, record) => {

    const PARAM_AUTHOR = 'custscript_pq_email_author';
    const PARAM_TEST_MODE = 'custscript_pq_test_mode';
    const PARAM_TEST_RECIPIENT = 'custscript_pq_test_recipient';
    const PARAM_FOLDER_ID = 'custscript_pq_folder_id';
    const PARAM_ERROR_RECIPIENT = 'custscript_pq_error_recipient';

    const FIELD_EMAIL_DELIVERY = 'custentity_email_delivery';
    const FIELD_LAST_SENT = 'custentity_last_supplier_report_sent';
    const FIELD_SUPPLIER_COMMITTED_DATE = 'custcolcommitted_date';
    const FIELD_APPROVAL_DATE = 'custbody_approve_date';

    const REPORT_NAME = 'Supplier Open PO Delivery Report';

    const getInputData = () => {
        return search.create({
            type: search.Type.PURCHASE_ORDER,
            filters: [
                ['mainline', 'is', 'F'],
                'AND',
                ['type', 'anyof', 'PurchOrd'],
                'AND',
                ['trandate', 'onorafter', '1/1/2024'],
                'AND',
                ['tranid', 'startswith', 'PO'],
                'AND',
                ['status', 'noneof', ['PurchOrd:H']],
                'AND',
                ['closed', 'is', 'F'],
                'AND',
                ['vendor.' + FIELD_EMAIL_DELIVERY, 'is', 'T']
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: FIELD_APPROVAL_DATE }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'memo' }),
                search.createColumn({ name: 'custcol_vendor_part_id' }),
                search.createColumn({ name: 'amount' }),
                search.createColumn({ name: 'expectedreceiptdate' }),
                search.createColumn({ name: FIELD_SUPPLIER_COMMITTED_DATE }),
                search.createColumn({ name: 'lastmodifieddate' }),

                search.createColumn({ name: 'internalid', join: 'vendor' }),
                search.createColumn({ name: 'companyname', join: 'vendor' }),
                search.createColumn({ name: 'entityid', join: 'vendor' }),
                search.createColumn({ name: 'email', join: 'vendor' })
            ]
        });
    };

    const map = (context) => {
        const result = JSON.parse(context.value);
        const values = result.values || {};

        const vendorId = getValue(values['internalid.vendor']);
        const vendorName =
            getValue(values['companyname.vendor']) ||
            getValue(values['entityid.vendor']) ||
            '';

        const poNumber = normalizePoNumber(getValue(values.tranid));

        if (!vendorId || !poNumber) {
            log.error('Vendor or valid PO number missing', result);
            return;
        }

        context.write({
            key: vendorId,
            value: {
                transactionId: result.id,
                date: getValue(values[FIELD_APPROVAL_DATE]),
                transactionDate: getValue(values.trandate),
                vendorId: vendorId,
                vendorName: vendorName,
                poNumber: poNumber,
                description: getValue(values.memo),
                vendorPartId: getValue(values.custcol_vendor_part_id),
                amount: getValue(values.amount),
                expectedReceiptDate: getValue(values.expectedreceiptdate),
                supplierCommittedDate: getValue(values[FIELD_SUPPLIER_COMMITTED_DATE]),
                lastModifiedDate: getValue(values.lastmodifieddate),
                vendorEmail: getValue(values['email.vendor'])
            }
        });
    };

    const reduce = (context) => {
        const script = runtime.getCurrentScript();

        const vendorId = context.key;
        const author = script.getParameter({ name: PARAM_AUTHOR });
        const folderId = script.getParameter({ name: PARAM_FOLDER_ID });
        const testMode =
            script.getParameter({ name: PARAM_TEST_MODE }) === true ||
            script.getParameter({ name: PARAM_TEST_MODE }) === 'T';
        const testRecipient = script.getParameter({ name: PARAM_TEST_RECIPIENT });

        if (!author) throw new Error('Missing Email Author parameter.');
        if (!folderId) throw new Error('Missing Folder ID parameter.');

        const rows = context.values.map((val) => JSON.parse(val));

        const vendorLookup = search.lookupFields({
            type: search.Type.VENDOR,
            id: vendorId,
            columns: ['email', FIELD_LAST_SENT]
        });

        const previousLastSent = vendorLookup[FIELD_LAST_SENT] || '';
        const lastSentDate = previousLastSent ? new Date(previousLastSent) : null;

        let vendorEmail = vendorLookup.email || '';
        let vendorName = '';

        const reportRows = rows.filter((row) => {
            if (!lastSentDate) return true;

            const rowModified = row.lastModifiedDate ? new Date(row.lastModifiedDate) : null;
            if (!rowModified) return true;

            return rowModified.getTime() > lastSentDate.getTime();
        });

        if (reportRows.length === 0) {
            log.audit('Skipping vendor - no PO line changes since last report', {
                vendorId: vendorId,
                previousLastSent: previousLastSent,
                totalOpenRows: rows.length
            });
            return;
        }

        let xls = '';
        xls += '<html><head><meta charset="UTF-8"></head><body>';
        xls += '<table border="1">';
        xls += '<tr>';
        xls += '<th>Approval Date</th>';
        xls += '<th>Supplier / Vendor</th>';
        xls += '<th>PO Number</th>';
        xls += '<th>Description</th>';
        xls += '<th>Vendor Part ID</th>';
        xls += '<th>Amount</th>';
        xls += '<th>Expected Receipt Date</th>';
        xls += '<th>Supplier Committed Date</th>';
        xls += '</tr>';

        reportRows.forEach((row) => {
            vendorName = vendorName || row.vendorName;
            vendorEmail = vendorEmail || row.vendorEmail;

            xls += '<tr>';
            xls += '<td>' + escapeHtml(row.date) + '</td>';
            xls += '<td>' + escapeHtml(row.vendorName) + '</td>';
            xls += '<td>' + escapeHtml(row.poNumber) + '</td>';
            xls += '<td>' + escapeHtml(row.description) + '</td>';
            xls += '<td>' + escapeHtml(row.vendorPartId) + '</td>';
            xls += '<td>' + escapeHtml(row.amount) + '</td>';
            xls += '<td>' + escapeHtml(row.expectedReceiptDate) + '</td>';
            xls += '<td>' + escapeHtml(row.supplierCommittedDate) + '</td>';
            xls += '</tr>';
        });

        xls += '</table></body></html>';

        const recipients = testMode
            ? parseRecipients(testRecipient)
            : parseRecipients(vendorEmail);

        if (!recipients || recipients.length === 0) {
            log.audit('Skipped vendor - no valid recipient email', {
                vendorId: vendorId,
                vendorName: vendorName,
                vendorEmail: vendorEmail,
                testMode: testMode
            });
            return;
        }

        const safeVendorName = sanitizeFileName(vendorName || ('Vendor_' + vendorId));
        const timestamp = getTimestamp();

        const xlsFile = file.create({
            name: 'Supplier_Open_PO_Delivery_Report_' + safeVendorName + '_' + timestamp + '.xls',
            fileType: file.Type.PLAINTEXT,
            contents: xls,
            folder: Number(folderId)
        });

        const fileId = xlsFile.save();
        const attachment = file.load({ id: fileId });

        email.send({
            author: Number(author),
            recipients: recipients,
            subject: REPORT_NAME + ' : ' + (vendorName || safeVendorName),
            body:
                'Hello,<br><br>' +
                'Please review the attached Supplier Open PO Delivery Report and update the "Supplier Committed Date" column for each purchase order line item. ' +
                'Kindly return the completed report to PsiQuantum at your earliest convenience.<br><br>' +
                'Thank you,<br>' +
                'Purchasing Team<br>' +
                'PsiQuantum Corp',
            attachments: [attachment]
        });

        record.submitFields({
            type: record.Type.VENDOR,
            id: vendorId,
            values: {
                [FIELD_LAST_SENT]: new Date()
            },
            options: {
                enableSourcing: false,
                ignoreMandatoryFields: true
            }
        });

        log.audit('Email sent and vendor last sent updated', {
            vendorId: vendorId,
            vendorName: vendorName,
            recipients: recipients,
            totalOpenRows: rows.length,
            reportRows: reportRows.length,
            previousLastSent: previousLastSent,
            testMode: testMode,
            fileId: fileId
        });
    };

    const summarize = (summary) => {
        const errors = [];

        if (summary.inputSummary && summary.inputSummary.error) {
            const msg = 'Input Error: ' + summary.inputSummary.error;
            log.error('Input Error', summary.inputSummary.error);
            errors.push(msg);
        }

        if (summary.mapSummary) {
            summary.mapSummary.errors.iterator().each((key, error) => {
                const msg = 'Map Error for key ' + key + ': ' + error;
                log.error('Map Error for key: ' + key, error);
                errors.push(msg);
                return true;
            });
        }

        if (summary.reduceSummary) {
            summary.reduceSummary.errors.iterator().each((key, error) => {
                const msg = 'Reduce Error for vendor ' + key + ': ' + error;
                log.error('Reduce Error for key: ' + key, error);
                errors.push(msg);
                return true;
            });
        }

        log.audit('Script completed', {
            usage: summary.usage,
            concurrency: summary.concurrency,
            yields: summary.yields,
            errorCount: errors.length
        });

        if (errors.length > 0) {
            sendErrorAlert(errors);
        }
    };

    const sendErrorAlert = (errors) => {
        try {
            const script = runtime.getCurrentScript();
            const author = script.getParameter({ name: PARAM_AUTHOR });
            const errorRecipient = script.getParameter({ name: PARAM_ERROR_RECIPIENT });
            const recipients = parseRecipients(errorRecipient);

            if (!author || recipients.length === 0) return;

            email.send({
                author: Number(author),
                recipients: recipients,
                subject: 'NetSuite Supplier Open PO Delivery Report Script Failed',
                body:
                    'The Supplier Open PO Delivery Report script completed with errors.<br><br>' +
                    '<b>Error count:</b> ' + errors.length + '<br><br>' +
                    '<pre>' + escapeHtml(errors.join('\n\n')) + '</pre>'
            });
        } catch (e) {
            log.error('Failed to send error alert', e);
        }
    };

    const normalizePoNumber = (value) => {
        const text = String(value || '').trim();
        return /^PO[0-9]+$/i.test(text) ? text.toUpperCase() : '';
    };

    const parseRecipients = (emailString) => {
        if (!emailString) return [];

        return String(emailString)
            .split(/[;,]/)
            .map((e) => e.trim())
            .filter((e) => e && e.indexOf('@') > -1);
    };

    const getValue = (field) => {
        if (field === null || field === undefined) return '';

        if (typeof field === 'object') {
            if (field.value !== undefined) return field.value;
            if (field.text !== undefined) return field.text;
        }

        return field;
    };

    const escapeHtml = (value) => {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

    const sanitizeFileName = (name) => {
        return String(name || 'Vendor')
            .replace(/[\\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 80);
    };

    const getTimestamp = () => {
        const now = new Date();

        return now.getFullYear().toString() +
            pad(now.getMonth() + 1) +
            pad(now.getDate()) + '_' +
            pad(now.getHours()) +
            pad(now.getMinutes()) +
            pad(now.getSeconds());
    };

    const pad = (num) => {
        return num < 10 ? '0' + num : String(num);
    };

    return {
        getInputData: getInputData,
        map: map,
        reduce: reduce,
        summarize: summarize
    };
});