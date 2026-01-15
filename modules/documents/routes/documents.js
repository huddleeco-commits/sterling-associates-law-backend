// backend/routes/documents.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../../uploads/documents');
        await fs.mkdir(uploadPath, { recursive: true });
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|heic/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Invalid file type'));
        }
    }
});

// Import models
const Document = require('../models/Document');
const Family = require('../models/Family');
const socketService = require('../services/socketService');

// Get all documents for family
router.get('/family/:familyId', async (req, res) => {
    try {
        const documents = await Document.find({ 
            familyId: req.params.familyId,
            isDeleted: false 
        }).sort('-uploadDate');
        
        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get documents by category
router.get('/category/:familyId/:category', async (req, res) => {
    try {
        const { familyId, category } = req.params;
        
        const documents = await Document.find({ 
            familyId,
            category,
            isDeleted: false 
        }).sort('-uploadDate');
        
        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get documents by member
router.get('/member/:familyId/:memberId', async (req, res) => {
    try {
        const { familyId, memberId } = req.params;
        
        const documents = await Document.find({ 
            familyId,
            owner: memberId,
            isDeleted: false 
        }).sort('-uploadDate');
        
        res.json({ success: true, documents });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Upload document
router.post('/upload', upload.single('document'), async (req, res) => {
    try {
        const { familyId, category, owner, extracted } = req.body;
        
        const document = new Document({
            familyId,
            name: req.file.originalname,
            filename: req.file.filename,
            path: req.file.path,
            type: req.file.mimetype,
            size: req.file.size,
            category: category || 'uncategorized',
            owner: owner || 'unknown',
            extracted: extracted ? JSON.parse(extracted) : {},
            uploadDate: new Date()
        });
        
        await document.save();
        
        // Process with AI
        const processedDoc = await processDocumentWithAI(document);
        
        // Sync to relevant platforms
        await syncDocumentToPlatforms(processedDoc);
        
        // Notify family members via WebSocket
        socketService.emitToFamily(familyId, 'document_uploaded', {
            document: processedDoc,
            uploadedBy: owner
        });
        
        res.json({ 
            success: true, 
            document: processedDoc,
            message: 'Document uploaded and processed successfully' 
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Process document with AI (OCR, categorization, extraction)
async function processDocumentWithAI(document) {
    try {
        // Simulate AI processing
        // In production, integrate with Tesseract.js or cloud OCR service
        
        // OCR Processing
        if (document.type.startsWith('image/')) {
            document.extractedText = await performOCR(document.path);
        }
        
        // AI Categorization
        if (document.extractedText) {
            document.category = await categorizeDocument(document.extractedText);
            
            // Extract category-specific fields
            document.extracted = await extractFields(document.extractedText, document.category);
        }
        
        // Generate insights
        document.insights = await generateInsights(document);
        
        await document.save();
        return document;
        
    } catch (error) {
        console.error('AI processing error:', error);
        return document;
    }
}

// Perform OCR
async function performOCR(imagePath) {
    // In production, use Tesseract.js or cloud service
    // Simulating OCR result
    return 'Sample extracted text from document';
}

// Categorize document
async function categorizeDocument(text) {
    const textLower = text.toLowerCase();
    
    if (textLower.includes('receipt') || textLower.includes('total') || textLower.includes('payment')) {
        return 'receipts';
    } else if (textLower.includes('medical') || textLower.includes('doctor') || textLower.includes('patient')) {
        return 'medical';
    } else if (textLower.includes('school') || textLower.includes('grade') || textLower.includes('student')) {
        return 'school';
    } else if (textLower.includes('warranty') || textLower.includes('guarantee')) {
        return 'warranties';
    } else if (textLower.includes('insurance') || textLower.includes('policy')) {
        return 'insurance';
    }
    
    return 'general';
}

// Extract fields based on category
async function extractFields(text, category) {
    const extracted = {};
    
    switch(category) {
        case 'receipts':
            extracted.vendor = extractVendor(text);
            extracted.amount = extractAmount(text);
            extracted.date = extractDate(text);
            extracted.items = extractItems(text);
            break;
            
        case 'medical':
            extracted.patient = extractPatientName(text);
            extracted.provider = extractProvider(text);
            extracted.diagnosis = extractDiagnosis(text);
            extracted.prescriptions = extractPrescriptions(text);
            break;
            
        case 'school':
            extracted.student = extractStudentName(text);
            extracted.grade = extractGrade(text);
            extracted.subject = extractSubject(text);
            extracted.dueDate = extractDueDate(text);
            break;
            
        case 'warranties':
            extracted.product = extractProduct(text);
            extracted.purchaseDate = extractPurchaseDate(text);
            extracted.expiryDate = extractExpiryDate(text);
            extracted.coverage = extractCoverage(text);
            break;
    }
    
    return extracted;
}

// Helper extraction functions
function extractVendor(text) {
    // Implement vendor extraction logic
    return 'Sample Vendor';
}

function extractAmount(text) {
    const amountMatch = text.match(/\$[\d,]+\.?\d*/);
    return amountMatch ? amountMatch[0] : null;
}

function extractDate(text) {
    const dateMatch = text.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
    return dateMatch ? dateMatch[0] : new Date().toLocaleDateString();
}

function extractItems(text) {
    // Extract line items from receipt
    return [];
}

function extractPatientName(text) {
    return 'Patient Name';
}

function extractProvider(text) {
    return 'Dr. Smith';
}

function extractDiagnosis(text) {
    return null;
}

function extractPrescriptions(text) {
    return [];
}

function extractStudentName(text) {
    return 'Student Name';
}

function extractGrade(text) {
    return null;
}

function extractSubject(text) {
    return null;
}

function extractDueDate(text) {
    return null;
}

function extractProduct(text) {
    return 'Product Name';
}

function extractPurchaseDate(text) {
    return new Date().toLocaleDateString();
}

function extractExpiryDate(text) {
    return null;
}

function extractCoverage(text) {
    return 'Standard Coverage';
}

// Generate insights
async function generateInsights(document) {
    const insights = [];
    
    if (document.category === 'receipts' && document.extracted.amount) {
        const amount = parseFloat(document.extracted.amount.replace('$', ''));
        if (isTaxDeductible(document)) {
            insights.push({
                type: 'tax_deduction',
                message: `Potential tax deduction of $${(amount * 0.25).toFixed(2)}`,
                priority: 'high'
            });
        }
    }
    
    if (document.category === 'warranties' && document.extracted.expiryDate) {
        const expiryDate = new Date(document.extracted.expiryDate);
        const daysUntilExpiry = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
        
        if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
            insights.push({
                type: 'expiry_warning',
                message: `Warranty expires in ${daysUntilExpiry} days`,
                priority: 'medium'
            });
        }
    }
    
    return insights;
}

function isTaxDeductible(document) {
    const deductibleKeywords = ['medical', 'charity', 'business', 'education', 'office'];
    const vendor = document.extracted?.vendor?.toLowerCase() || '';
    
    return deductibleKeywords.some(keyword => vendor.includes(keyword));
}

// Sync document to other platforms
async function syncDocumentToPlatforms(document) {
    const syncMap = {
        'receipts': ['meals', 'kids-banking'],
        'medical': ['medical', 'calendar', 'emergency'],
        'school': ['calendar', 'tasks'],
        'warranties': ['home', 'calendar'],
        'insurance': ['emergency', 'calendar'],
        'recipes': ['meals']
    };
    
    const platformsToSync = syncMap[document.category] || [];
    
    for (const platform of platformsToSync) {
        await syncToPlatform(document, platform);
    }
}

async function syncToPlatform(document, platform) {
    const syncService = require('../services/SyncService');
    
    const syncData = {
        platform: 'documents',
        targetPlatform: platform,
        data: {
            documentId: document._id,
            name: document.name,
            category: document.category,
            extracted: document.extracted,
            uploadDate: document.uploadDate,
            familyId: document.familyId
        }
    };
    
    // Platform-specific sync data
    switch(platform) {
        case 'meals':
            if (document.category === 'receipts') {
                syncData.data.groceryReceipt = {
                    vendor: document.extracted.vendor,
                    amount: document.extracted.amount,
                    items: document.extracted.items
                };
            } else if (document.category === 'recipes') {
                syncData.data.recipe = document.extracted;
            }
            break;
            
        case 'medical':
            syncData.data.medicalRecord = {
                patient: document.extracted.patient,
                provider: document.extracted.provider,
                diagnosis: document.extracted.diagnosis,
                prescriptions: document.extracted.prescriptions
            };
            break;
            
        case 'calendar':
            if (document.extracted.expiryDate) {
                syncData.data.event = {
                    title: `${document.name} expires`,
                    date: document.extracted.expiryDate,
                    type: 'document_expiry'
                };
            }
            break;
            
        case 'kids-banking':
            if (document.extracted.amount) {
                syncData.data.expense = {
                    amount: document.extracted.amount,
                    vendor: document.extracted.vendor,
                    date: document.extracted.date,
                    receiptId: document._id
                };
            }
            break;
    }
    
    await syncService.handleIncomingSync(platform, syncData.data, document.familyId);
}

// Search documents
router.post('/search', async (req, res) => {
    try {
        const { familyId, query, filters } = req.body;
        
        let searchQuery = {
            familyId,
            isDeleted: false
        };
        
        // Apply filters
        if (filters?.category) {
            searchQuery.category = filters.category;
        }
        
        if (filters?.owner) {
            searchQuery.owner = filters.owner;
        }
        
        if (filters?.dateRange) {
            searchQuery.uploadDate = {
                $gte: new Date(filters.dateRange.start),
                $lte: new Date(filters.dateRange.end)
            };
        }
        
        // Text search
        if (query) {
            searchQuery.$or = [
                { name: { $regex: query, $options: 'i' } },
                { extractedText: { $regex: query, $options: 'i' } },
                { 'extracted.vendor': { $regex: query, $options: 'i' } }
            ];
        }
        
        const documents = await Document.find(searchQuery)
            .sort('-uploadDate')
            .limit(50);
        
        res.json({ success: true, documents });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get document insights
router.get('/insights/:familyId', async (req, res) => {
    try {
        const { familyId } = req.params;
        
        const documents = await Document.find({ 
            familyId,
            isDeleted: false 
        });
        
        const insights = {
            totalDocuments: documents.length,
            byCategory: {},
            taxDeductions: 0,
            expiringDocuments: [],
            recentActivity: []
        };
        
        // Count by category
        documents.forEach(doc => {
            insights.byCategory[doc.category] = (insights.byCategory[doc.category] || 0) + 1;
            
            // Calculate tax deductions
            if (doc.category === 'receipts' && isTaxDeductible(doc)) {
                const amount = parseFloat(doc.extracted?.amount?.replace('$', '') || 0);
                insights.taxDeductions += amount;
            }
            
            // Find expiring documents
            if (doc.extracted?.expiryDate) {
                const expiryDate = new Date(doc.extracted.expiryDate);
                const daysUntil = Math.floor((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
                
                if (daysUntil <= 30 && daysUntil > 0) {
                    insights.expiringDocuments.push({
                        document: doc,
                        daysUntilExpiry: daysUntil
                    });
                }
            }
        });
        
        // Recent activity
        insights.recentActivity = documents
            .sort((a, b) => b.uploadDate - a.uploadDate)
            .slice(0, 10)
            .map(doc => ({
                id: doc._id,
                name: doc.name,
                category: doc.category,
                uploadDate: doc.uploadDate
            }));
        
        res.json({ success: true, insights });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Share document
router.post('/share/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;
        const { shareWith, permissions, expiryDate } = req.body;
        
        const document = await Document.findById(documentId);
        if (!document) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        
        // Create share link
        const shareLink = {
            documentId,
            token: generateShareToken(),
            sharedWith: shareWith,
            permissions: permissions || ['view'],
            expiryDate: expiryDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            createdAt: new Date()
        };
        
        document.shares = document.shares || [];
        document.shares.push(shareLink);
        await document.save();
        
        // Notify via WebSocket
        socketService.emitToFamily(document.familyId, 'document_shared', {
            document: document.name,
            sharedBy: req.body.sharedBy,
            sharedWith: shareWith
        });
        
        res.json({ 
            success: true, 
            shareLink: `${req.protocol}://${req.get('host')}/documents/shared/${shareLink.token}`
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

function generateShareToken() {
    return Math.random().toString(36).substr(2) + Date.now().toString(36);
}

// Delete document
router.delete('/:documentId', async (req, res) => {
    try {
        const { documentId } = req.params;
        
        const document = await Document.findById(documentId);
        if (!document) {
            return res.status(404).json({ success: false, error: 'Document not found' });
        }
        
        // Soft delete
        document.isDeleted = true;
        document.deletedAt = new Date();
        await document.save();
        
        // Notify family
        socketService.emitToFamily(document.familyId, 'document_deleted', {
            documentId,
            deletedBy: req.body.deletedBy
        });
        
        res.json({ success: true, message: 'Document deleted successfully' });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Batch operations
router.post('/batch/categorize', async (req, res) => {
    try {
        const { familyId, documentIds } = req.body;
        
        const documents = await Document.find({
            _id: { $in: documentIds },
            familyId
        });
        
        const categorized = [];
        
        for (const doc of documents) {
            if (doc.category === 'uncategorized') {
                doc.category = await categorizeDocument(doc.extractedText || doc.name);
                doc.extracted = await extractFields(doc.extractedText || '', doc.category);
                await doc.save();
                categorized.push(doc);
            }
        }
        
        res.json({ 
            success: true, 
            message: `Categorized ${categorized.length} documents`,
            documents: categorized
        });
        
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;