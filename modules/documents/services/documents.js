// backend/services/documentsIntegration.js
const Document = require('../models/Document');
const socketService = require('./socketService');

class DocumentsIntegration {
    constructor() {
        this.syncQueue = [];
        this.processing = false;
    }

    // Initialize integration with socket service
    initialize(io) {
        this.io = io;
        console.log('Documents Integration Service initialized');
    }

    // Handle incoming document requests from other platforms
    async handleDocumentRequest(platformId, request) {
        try {
            const { familyId, type, filters } = request;

            switch(type) {
                case 'get_receipts':
                    return await this.getReceipts(familyId, filters);
                    
                case 'get_medical_records':
                    return await this.getMedicalRecords(familyId, filters);
                    
                case 'get_warranties':
                    return await this.getWarranties(familyId, filters);
                    
                case 'search_documents':
                    return await this.searchDocuments(familyId, filters);
                    
                case 'get_expiring':
                    return await this.getExpiringDocuments(familyId);
                    
                default:
                    return { success: false, error: 'Unknown request type' };
            }
        } catch (error) {
            console.error('Document request error:', error);
            return { success: false, error: error.message };
        }
    }

    // Sync document to specific platform
    async syncToPlatform(document, targetPlatform) {
        const syncHandlers = {
            'meals': this.syncToMeals.bind(this),
            'medical': this.syncToMedical.bind(this),
            'calendar': this.syncToCalendar.bind(this),
            'kids-banking': this.syncToKidsBanking.bind(this),
            'home': this.syncToHome.bind(this),
            'emergency': this.syncToEmergency.bind(this),
            'tasks': this.syncToTasks.bind(this)
        };

        const handler = syncHandlers[targetPlatform];
        if (handler) {
            await handler(document);
        }
    }

    // Sync receipt to meals platform
    async syncToMeals(document) {
        if (document.category !== 'receipts' && document.category !== 'recipes') return;

        const syncData = {
            type: 'document_sync',
            source: 'documents',
            documentId: document._id,
            familyId: document.familyId
        };

        if (document.category === 'receipts') {
            syncData.receipt = {
                vendor: document.extracted?.vendor,
                amount: document.extracted?.amount,
                date: document.extracted?.date,
                items: document.extracted?.items || [],
                tax: document.extracted?.tax
            };

            // Emit to meals platform
            socketService.emitToFamily(document.familyId, 'meals_receipt_sync', syncData);
            
            // If items detected, add to pantry inventory
            if (document.extracted?.items?.length > 0) {
                socketService.emitToFamily(document.familyId, 'pantry_update', {
                    action: 'add_items',
                    items: document.extracted.items,
                    source: 'receipt_scan'
                });
            }
        } else if (document.category === 'recipes') {
            syncData.recipe = {
                name: document.name,
                ingredients: document.extracted?.ingredients,
                servings: document.extracted?.servings,
                prepTime: document.extracted?.prepTime,
                calories: document.extracted?.calories
            };

            socketService.emitToFamily(document.familyId, 'meals_recipe_sync', syncData);
        }
    }

    // Sync medical document to medical platform
    async syncToMedical(document) {
        if (document.category !== 'medical') return;

        const syncData = {
            type: 'document_sync',
            source: 'documents',
            documentId: document._id,
            familyId: document.familyId,
            medicalRecord: {
                patient: document.extracted?.patient,
                provider: document.extracted?.provider,
                diagnosis: document.extracted?.diagnosis,
                prescriptions: document.extracted?.prescriptions,
                appointmentDate: document.extracted?.appointmentDate,
                documentUrl: `/api/documents/view/${document._id}`
            }
        };

        socketService.emitToFamily(document.familyId, 'medical_record_sync', syncData);

        // If appointment date exists, sync to calendar
        if (document.extracted?.appointmentDate) {
            await this.syncToCalendar(document);
        }

        // If prescriptions exist, create medication reminders
        if (document.extracted?.prescriptions?.length > 0) {
            socketService.emitToFamily(document.familyId, 'medication_reminder_create', {
                prescriptions: document.extracted.prescriptions,
                patient: document.extracted.patient
            });
        }
    }

    // Sync to calendar for dates and deadlines
    async syncToCalendar(document) {
        const events = [];

        // Check for expiry dates
        if (document.extracted?.expiryDate) {
            events.push({
                title: `${document.name} expires`,
                date: document.extracted.expiryDate,
                type: 'document_expiry',
                category: document.category,
                documentId: document._id
            });
        }

        // Check for due dates (school)
        if (document.extracted?.dueDate) {
            events.push({
                title: `Due: ${document.name}`,
                date: document.extracted.dueDate,
                type: 'document_deadline',
                student: document.extracted.student,
                documentId: document._id
            });
        }

        // Check for appointment dates (medical)
        if (document.extracted?.appointmentDate) {
            events.push({
                title: `Medical: ${document.extracted.provider}`,
                date: document.extracted.appointmentDate,
                type: 'medical_appointment',
                patient: document.extracted.patient,
                documentId: document._id
            });
        }

        // Emit events to calendar
        events.forEach(event => {
            socketService.emitToFamily(document.familyId, 'calendar_event_create', {
                source: 'documents',
                event
            });
        });
    }

    // Sync financial documents to kids banking
    async syncToKidsBanking(document) {
        if (document.category !== 'receipts' || !document.extracted?.amount) return;

        const syncData = {
            type: 'expense_sync',
            source: 'documents',
            expense: {
                amount: document.extracted.amount,
                vendor: document.extracted.vendor,
                date: document.extracted.date,
                category: this.categorizeExpense(document),
                receiptId: document._id,
                receiptUrl: `/api/documents/view/${document._id}`
            }
        };

        socketService.emitToFamily(document.familyId, 'banking_expense_sync', syncData);

        // Check if it's a chore payment
        if (document.extracted?.vendor?.toLowerCase().includes('allowance') || 
            document.extracted?.vendor?.toLowerCase().includes('chore')) {
            socketService.emitToFamily(document.familyId, 'chore_payment_detected', {
                amount: document.extracted.amount,
                date: document.extracted.date,
                documentId: document._id
            });
        }
    }

    // Categorize expense for banking
    categorizeExpense(document) {
        const vendor = document.extracted?.vendor?.toLowerCase() || '';
        
        if (vendor.includes('toy') || vendor.includes('game')) return 'toys';
        if (vendor.includes('food') || vendor.includes('restaurant')) return 'food';
        if (vendor.includes('school') || vendor.includes('book')) return 'education';
        if (vendor.includes('clothes') || vendor.includes('shoe')) return 'clothing';
        
        return 'other';
    }

    // Sync warranties to home platform
    async syncToHome(document) {
        if (document.category !== 'warranties' && document.category !== 'insurance') return;

        const syncData = {
            type: 'document_sync',
            source: 'documents',
            documentId: document._id,
            familyId: document.familyId
        };

        if (document.category === 'warranties') {
            syncData.warranty = {
                product: document.extracted?.product,
                purchaseDate: document.extracted?.purchaseDate,
                expiryDate: document.extracted?.expiryDate,
                coverage: document.extracted?.coverage,
                serialNumber: document.extracted?.serialNumber
            };

            socketService.emitToFamily(document.familyId, 'home_warranty_sync', syncData);

            // Create maintenance reminders
            if (document.extracted?.product) {
                this.createMaintenanceReminders(document);
            }
        }
    }

    // Create maintenance reminders for home products
    createMaintenanceReminders(document) {
        const product = document.extracted.product.toLowerCase();
        const reminders = [];

        if (product.includes('hvac') || product.includes('air condition')) {
            reminders.push({
                type: 'filter_replacement',
                frequency: 'monthly',
                product: document.extracted.product
            });
        }

        if (product.includes('water heater')) {
            reminders.push({
                type: 'inspection',
                frequency: 'yearly',
                product: document.extracted.product
            });
        }

        if (reminders.length > 0) {
            socketService.emitToFamily(document.familyId, 'maintenance_reminder_create', {
                documentId: document._id,
                reminders
            });
        }
    }

    // Sync critical documents to emergency platform
    async syncToEmergency(document) {
        const criticalCategories = ['medical', 'insurance', 'identification', 'legal'];
        
        if (!criticalCategories.includes(document.category)) return;

        const syncData = {
            type: 'critical_document_sync',
            source: 'documents',
            document: {
                id: document._id,
                name: document.name,
                category: document.category,
                owner: document.owner,
                url: `/api/documents/emergency/${document._id}`
            }
        };

        // Add category-specific data
        switch(document.category) {
            case 'medical':
                syncData.document.medicalInfo = {
                    patient: document.extracted?.patient,
                    conditions: document.extracted?.diagnosis,
                    medications: document.extracted?.prescriptions,
                    allergies: document.extracted?.allergies
                };
                break;
                
            case 'insurance':
                syncData.document.insuranceInfo = {
                    policyNumber: document.extracted?.policyNumber,
                    coverage: document.extracted?.coverage,
                    provider: document.extracted?.provider
                };
                break;
                
            case 'identification':
                syncData.document.idInfo = {
                    idNumber: document.extracted?.idNumber,
                    expiryDate: document.extracted?.expiryDate
                };
                break;
        }

        socketService.emitToFamily(document.familyId, 'emergency_document_sync', syncData);
    }

    // Sync to tasks platform for action items
    async syncToTasks(document) {
        const tasks = [];

        // Create task for expiring documents
        if (document.extracted?.expiryDate) {
            const expiryDate = new Date(document.extracted.expiryDate);
            const reminderDate = new Date(expiryDate);
            reminderDate.setDate(reminderDate.getDate() - 30); // 30 days before

            tasks.push({
                title: `Renew ${document.name}`,
                dueDate: reminderDate,
                priority: 'medium',
                category: 'documents',
                documentId: document._id
            });
        }

        // School documents needing signatures
        if (document.category === 'school' && document.name.toLowerCase().includes('form')) {
            tasks.push({
                title: `Sign and return: ${document.name}`,
                dueDate: document.extracted?.dueDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
                priority: 'high',
                assignedTo: document.extracted?.student,
                documentId: document._id
            });
        }

        // Emit tasks
        tasks.forEach(task => {
            socketService.emitToFamily(document.familyId, 'task_create', {
                source: 'documents',
                task
            });
        });
    }

    // Get receipts for meals platform
    async getReceipts(familyId, filters = {}) {
        const query = {
            familyId,
            category: 'receipts',
            isDeleted: false
        };

        if (filters.dateRange) {
            query.uploadDate = {
                $gte: new Date(filters.dateRange.start),
                $lte: new Date(filters.dateRange.end)
            };
        }

        if (filters.vendor) {
            query['extracted.vendor'] = { $regex: filters.vendor, $options: 'i' };
        }

        const receipts = await Document.find(query)
            .select('name extracted uploadDate')
            .sort('-uploadDate')
            .limit(filters.limit || 50);

        return {
            success: true,
            receipts: receipts.map(r => ({
                id: r._id,
                name: r.name,
                vendor: r.extracted?.vendor,
                amount: r.extracted?.amount,
                date: r.extracted?.date || r.uploadDate,
                items: r.extracted?.items
            }))
        };
    }

    // Get medical records
    async getMedicalRecords(familyId, filters = {}) {
        const query = {
            familyId,
            category: 'medical',
            isDeleted: false
        };

        if (filters.patient) {
            query['extracted.patient'] = filters.patient;
        }

        const records = await Document.find(query)
            .sort('-uploadDate')
            .limit(filters.limit || 50);

        return {
            success: true,
            records: records.map(r => ({
                id: r._id,
                name: r.name,
                patient: r.extracted?.patient,
                provider: r.extracted?.provider,
                date: r.extracted?.appointmentDate || r.uploadDate,
                diagnosis: r.extracted?.diagnosis,
                prescriptions: r.extracted?.prescriptions
            }))
        };
    }

    // Get warranties for home platform
    async getWarranties(familyId, filters = {}) {
        const query = {
            familyId,
            category: 'warranties',
            isDeleted: false
        };

        const warranties = await Document.find(query)
            .sort('extracted.expiryDate')
            .limit(filters.limit || 50);

        return {
            success: true,
            warranties: warranties.map(w => ({
                id: w._id,
                product: w.extracted?.product,
                purchaseDate: w.extracted?.purchaseDate,
                expiryDate: w.extracted?.expiryDate,
                coverage: w.extracted?.coverage,
                isExpiring: w.isExpiring()
            }))
        };
    }

    // Get expiring documents
    async getExpiringDocuments(familyId, days = 30) {
        const documents = await Document.findExpiring(familyId, days);
        
        return {
            success: true,
            expiring: documents.map(d => ({
                id: d._id,
                name: d.name,
                category: d.category,
                expiryDate: d.extracted.expiryDate,
                daysRemaining: Math.floor(
                    (new Date(d.extracted.expiryDate) - new Date()) / (1000 * 60 * 60 * 24)
                )
            }))
        };
    }

    // Search documents
    async searchDocuments(familyId, filters = {}) {
        const query = {
            familyId,
            isDeleted: false
        };

        if (filters.query) {
            query.$text = { $search: filters.query };
        }

        if (filters.categories) {
            query.category = { $in: filters.categories };
        }

        if (filters.tags) {
            query.tags = { $in: filters.tags };
        }

        const documents = await Document.find(query)
            .limit(filters.limit || 50)
            .sort(filters.sort || '-uploadDate');

        return {
            success: true,
            documents: documents.map(d => ({
                id: d._id,
                name: d.name,
                category: d.category,
                uploadDate: d.uploadDate,
                owner: d.owner,
                extracted: d.extracted
            }))
        };
    }

    // Process sync from other platforms
    async processIncomingSync(sourcePlatform, data, familyId) {
        try {
            switch(sourcePlatform) {
                case 'meals':
                    if (data.type === 'recipe_to_documents') {
                        await this.saveRecipeAsDocument(data, familyId);
                    }
                    break;
                    
                case 'medical':
                    if (data.type === 'record_to_documents') {
                        await this.saveMedicalRecord(data, familyId);
                    }
                    break;
                    
                case 'home':
                    if (data.type === 'warranty_to_documents') {
                        await this.saveWarranty(data, familyId);
                    }
                    break;
            }
        } catch (error) {
            console.error('Incoming sync error:', error);
        }
    }

    // Save recipe from meals platform
    async saveRecipeAsDocument(data, familyId) {
        const document = new Document({
            familyId,
            name: data.recipe.name,
            category: 'recipes',
            owner: data.createdBy || 'system',
            extracted: {
                ingredients: data.recipe.ingredients,
                servings: data.recipe.servings,
                prepTime: data.recipe.prepTime,
                calories: data.recipe.nutrition?.calories
            },
            extractedText: JSON.stringify(data.recipe),
            type: 'application/json',
            size: JSON.stringify(data.recipe).length,
            filename: `recipe_${Date.now()}.json`,
            path: 'virtual',
            uploadDate: new Date()
        });

        await document.save();

        // Notify
        socketService.emitToFamily(familyId, 'document_created', {
            source: 'meals',
            document: document
        });
    }

    // Save medical record
    async saveMedicalRecord(data, familyId) {
        const document = new Document({
            familyId,
            name: `Medical Record - ${data.patient} - ${new Date().toLocaleDateString()}`,
            category: 'medical',
            owner: data.patient,
            extracted: {
                patient: data.patient,
                provider: data.provider,
                diagnosis: data.diagnosis,
                prescriptions: data.prescriptions,
                appointmentDate: data.date
            },
            type: 'application/json',
            size: JSON.stringify(data).length,
            filename: `medical_${Date.now()}.json`,
            path: 'virtual',
            uploadDate: new Date()
        });

        await document.save();

        socketService.emitToFamily(familyId, 'document_created', {
            source: 'medical',
            document: document
        });
    }

    // Save warranty from home platform
    async saveWarranty(data, familyId) {
        const document = new Document({
            familyId,
            name: `Warranty - ${data.product}`,
            category: 'warranties',
            owner: data.owner || 'family',
            extracted: {
                product: data.product,
                purchaseDate: data.purchaseDate,
                expiryDate: data.expiryDate,
                coverage: data.coverage,
                serialNumber: data.serialNumber
            },
            type: 'application/json',
            size: JSON.stringify(data).length,
            filename: `warranty_${Date.now()}.json`,
            path: 'virtual',
            uploadDate: new Date()
        });

        await document.save();

        // Create calendar reminder for expiry
        if (data.expiryDate) {
            await this.syncToCalendar(document);
        }

        socketService.emitToFamily(familyId, 'document_created', {
            source: 'home',
            document: document
        });
    }
}

module.exports = new DocumentsIntegration();