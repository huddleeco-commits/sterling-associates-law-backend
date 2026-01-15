const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { query, body, param, validationResult } = require('express-validator');
const sanitizeHtml = require('sanitize-html');
const rateLimit = require('express-rate-limit');
const Redis = require('redis');
const User = require('../models/User');
const Card = require('../models/Card');
const PendingAction = require('../models/PendingAction');
const Trade = require('../models/Trade');
const Listing = require('../models/Listing');
const authMiddleware = require('../middleware/authMiddleware');
const { notifyUser } = require('../services/notificationService');

// ============================================================================
// ENHANCED REDIS SETUP - Matching cards.js pattern
// ============================================================================
let redisClient;
let isRedisConnected = false;

const initializeRedis = async () => {
  try {
    redisClient = Redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      retry_strategy: (options) => {
        if (options.error && options.error.code === 'ECONNREFUSED') {
          console.warn('[Redis Admin] Connection refused, will retry...');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
          console.error('[Redis Admin] Retry time exhausted');
          return new Error('Redis retry time exhausted');
        }
        if (options.attempt > 10) {
          console.error('[Redis Admin] Max retry attempts reached');
          return undefined;
        }
        return Math.min(options.attempt * 100, 3000);
      }
    });

    redisClient.on('connect', () => {
      console.log('[Redis Admin] Connected successfully');
      isRedisConnected = true;
    });

    redisClient.on('error', (err) => {
      console.warn('[Redis Admin] Connection error:', err.message);
      isRedisConnected = false;
    });

    redisClient.on('end', () => {
      console.warn('[Redis Admin] Connection ended');
      isRedisConnected = false;
    });

    await redisClient.connect();
  } catch (error) {
    console.warn('[Redis Admin] Failed to initialize:', error.message);
    isRedisConnected = false;
  }
};

// Initialize Redis
// // initializeRedis();

// Enhanced cache helper functions
const getCachedData = async (key) => {
  if (!isRedisConnected) return null;
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.warn('[Admin Cache] Get error:', error.message);
    return null;
  }
};

const setCachedData = async (key, data, expiration = 300) => {
  if (!isRedisConnected) return false;
  try {
    await redisClient.setEx(key, expiration, JSON.stringify(data));
    return true;
  } catch (error) {
    console.warn('[Admin Cache] Set error:', error.message);
    return false;
  }
};

const invalidateCache = async (pattern) => {
  if (!isRedisConnected) return;
  try {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(keys);
      console.log(`[Admin Cache] Invalidated ${keys.length} keys matching ${pattern}`);
    }
  } catch (error) {
    console.warn('[Admin Cache] Invalidation error:', error.message);
  }
};

// ============================================================================
// ENHANCED RATE LIMITERS - Fixed Rate Limiting Issues
// ============================================================================
const createRateLimiter = (windowMs, max, message) => rateLimit({
  windowMs,
  max: (req) => {
    // Fix: Never return 0, use high limit instead for admins
    if (req.ip === process.env.TEST_IP || req.user?._id === process.env.ADMIN_USER_ID) {
      return 10000; // Very high limit instead of 0
    }
    return req.user?.isAdmin || req.user?.role === 'master' ? max * 5 : max;
  },
  message: { error: message },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `admin-${req.ip}-${req.user?._id || 'anonymous'}`,
  skip: (req) => {
    // Skip rate limiting for admin/master users
    return req.user?.isAdmin || req.user?.role === 'master';
  }
});

const getLimiter = createRateLimiter(15 * 60 * 1000, 200, 'Too many admin GET requests');
const postLimiter = createRateLimiter(15 * 60 * 1000, 100, 'Too many admin POST requests');

// ============================================================================
// ENHANCED CACHE MIDDLEWARE
// ============================================================================
const cacheMiddleware = (keyPrefix, ttl = 300) => async (req, res, next) => {
  try {
    const cacheKey = `admin:${keyPrefix}:${req.originalUrl}:${req.user._id}`;
    const cached = await getCachedData(cacheKey);
    
    if (cached) {
      console.log(`[Admin Cache] Cache hit for ${keyPrefix}`);
      return res.json(cached);
    }
    
    // Store original json function
    res.sendResponse = res.json;
    res.json = async (body) => {
      // Cache successful responses only
      if (body.success !== false) {
        await setCachedData(cacheKey, body, ttl);
        console.log(`[Admin Cache] Cached response for ${keyPrefix}`);
      }
      res.sendResponse(body);
    };
    next();
  } catch (err) {
    console.warn('[Admin Cache] Cache middleware error:', err.message);
    next(); // Continue without caching
  }
};

// ============================================================================
// ENHANCED ADMIN VERIFICATION MIDDLEWARE
// ============================================================================
const requireAdminOrMaster = async (req, res, next) => {
  try {
    if (!req.user?.isAdmin && req.user?.role !== 'master') {
      console.log(`[Admin] Access denied for user ${req.user._id} with role ${req.user?.role}`);
      
      // Log failed access attempt with enhanced details
      await User.updateOne(
        { _id: req.user._id },
        { 
          $push: { 
            activities: {
              type: 'admin_access_denied',
              details: { 
                endpoint: req.originalUrl,
                method: req.method,
                reason: 'insufficient_privileges',
                ip: req.ip,
                userAgent: req.get('User-Agent'),
                timestamp: new Date()
              },
              timestamp: new Date()
            }
          }
        }
      );
      
      return res.status(403).json({ 
        success: false,
        message: 'Admin or Master role required',
        errorCode: 'INSUFFICIENT_PRIVILEGES'
      });
    }

    // Verify user still exists and is active
    const currentUser = await User.findById(req.user._id)
      .select('isAdmin role isSuspended isBanned username')
      .lean();
      
    if (!currentUser || currentUser.isSuspended || currentUser.isBanned) {
      return res.status(403).json({ 
        success: false,
        message: 'Account access restricted',
        errorCode: 'ACCOUNT_RESTRICTED'
      });
    }

    // Log successful admin access (non-blocking)
    setImmediate(async () => {
      try {
        await User.updateOne(
          { _id: req.user._id },
          { 
            $push: { 
              activities: {
                type: 'admin_access',
                details: { 
                  endpoint: req.originalUrl,
                  method: req.method,
                  ip: req.ip,
                  timestamp: new Date()
                },
                timestamp: new Date()
              }
            }
          }
        );
      } catch (err) {
        console.warn('[Admin] Failed to log admin access:', err.message);
      }
    });

    next();
  } catch (err) {
    console.error('[Admin] Error in admin verification:', err.message);
    res.status(500).json({ 
      success: false,
      message: 'Error verifying admin access',
      errorCode: 'VERIFICATION_ERROR'
    });
  }
};

// ============================================================================
// INPUT VALIDATION HELPERS
// ============================================================================
const validateAndSanitize = {
  searchTerm: (value) => {
    if (!value) return '';
    return sanitizeHtml(value.trim(), { allowedTags: [], allowedAttributes: {} });
  },
  
  reason: (value) => {
    if (!value) return '';
    const sanitized = sanitizeHtml(value.trim(), { allowedTags: [], allowedAttributes: {} });
    return sanitized.length > 500 ? sanitized.substring(0, 500) : sanitized;
  },
  
  objectId: (value) => {
    return mongoose.Types.ObjectId.isValid(value) ? value : null;
  }
};

// ============================================================================
// ENHANCED USER MANAGEMENT ENDPOINT
// ============================================================================
router.get('/users', getLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('role').optional().isIn(['user', 'admin', 'master', 'parent']).withMessage('Invalid role filter'),
  query('search').optional().trim().isLength({ max: 100 }).withMessage('Search term too long'),
  query('sortBy').optional().isIn(['username', 'email', 'createdAt', 'kidzcoinBalance', 'dollarBalance', 'lastActive']).withMessage('Invalid sort field'),
  query('sortOrder').optional().isIn(['asc', 'desc']).withMessage('Sort order must be asc or desc'),
  query('hasParent').optional().isBoolean().withMessage('hasParent must be a boolean'),
  query('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  query('hasCards').optional().isBoolean().withMessage('hasCards must be a boolean')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/users');
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin Users] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    const { 
      role, 
      search, 
      sortBy = 'createdAt', 
      sortOrder = 'desc', 
      hasParent, 
      isActive,
      hasCards 
    } = req.query;

    // Build cache key
    const cacheKey = `admin:users:${JSON.stringify({
      page, limit, role, search, sortBy, sortOrder, hasParent, isActive, hasCards
    })}`;
    
    let result = await getCachedData(cacheKey);
    
    if (!result) {
      console.log('[Admin Users] Cache miss, querying database');

      // Build query filter with enhanced options
      let query = {};
      
      if (role) {
        query.role = role;
      }
      
      if (search) {
        const searchTerm = validateAndSanitize.searchTerm(search);
        query.$or = [
          { username: new RegExp(searchTerm, 'i') },
          { email: new RegExp(searchTerm, 'i') },
          { firstName: new RegExp(searchTerm, 'i') },
          { lastName: new RegExp(searchTerm, 'i') }
        ];
      }
      
      if (hasParent === 'true') {
        query.parentId = { $ne: null };
      } else if (hasParent === 'false') {
        query.parentId = null;
      }

      if (isActive === 'true') {
        query.isSuspended = { $ne: true };
        query.isBanned = { $ne: true };
      } else if (isActive === 'false') {
        query.$or = [{ isSuspended: true }, { isBanned: true }];
      }

      if (hasCards === 'true') {
        query.assignedCards = { $exists: true, $not: { $size: 0 } };
      } else if (hasCards === 'false') {
        query.$or = [
          { assignedCards: { $exists: false } },
          { assignedCards: { $size: 0 } }
        ];
      }

      // Build sort object with enhanced options
      const sortObj = {};
      if (sortBy === 'lastActive') {
        sortObj['activities.timestamp'] = sortOrder === 'asc' ? 1 : -1;
      } else {
        sortObj[sortBy] = sortOrder === 'asc' ? 1 : -1;
      }

      // Get total count for pagination
      const totalUsers = await User.countDocuments(query);

      // Fetch users with enhanced data
      const users = await User.find(query)
        .select('-passwordHash')
        .populate('parentId', 'username email')
        .populate({
          path: 'assignedCards',
          select: 'player_name team_name card_set year currentValuation',
          options: { limit: 5 } // Limit to prevent large payloads
        })
        .sort(sortObj)
        .skip(skip)
        .limit(limit)
        .lean();

      // Enhanced user statistics with batch operations
      const userIds = users.map(u => u._id);
      
      // Batch fetch children counts
      const childrenCounts = await User.aggregate([
        { $match: { parentId: { $in: userIds } } },
        { $group: { _id: '$parentId', count: { $sum: 1 } } }
      ]);
      const childrenMap = new Map(childrenCounts.map(c => [c._id.toString(), c.count]));

      // Batch fetch pending actions
      const pendingActionCounts = await PendingAction.aggregate([
        { $match: { userId: { $in: userIds }, status: 'pending' } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
      ]);
      const pendingMap = new Map(pendingActionCounts.map(p => [p._id.toString(), p.count]));

      // Batch fetch active listings
      const listingCounts = await Listing.aggregate([
        { $match: { listedBy: { $in: userIds }, status: 'active' } },
        { $group: { _id: '$listedBy', count: { $sum: 1 } } }
      ]);
      const listingMap = new Map(listingCounts.map(l => [l._id.toString(), l.count]));

      // Enhance user data with statistics
      const enhancedUsers = users.map((user) => {
        const userId = user._id.toString();
        
        // Calculate recent activity count (last 7 days)
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const recentActivityCount = (user.activities || []).filter(
          activity => new Date(activity.timestamp) >= weekAgo
        ).length;

        // Calculate portfolio value
        const cardValues = (user.assignedCards || []).reduce((sum, card) => 
          sum + (card.currentValuation || 0), 0
        );
        const portfolioValue = (user.dollarBalance || 0) + 
                              ((user.kidzcoinBalance || 0) * 0.001) + 
                              cardValues;

        return {
          ...user,
          statistics: {
            childrenCount: childrenMap.get(userId) || 0,
            pendingActionsCount: pendingMap.get(userId) || 0,
            recentActivityCount,
            activeListingsCount: listingMap.get(userId) || 0,
            totalCards: user.assignedCards?.length || 0,
            portfolioValue: Math.round(portfolioValue * 100) / 100,
            cardValue: Math.round(cardValues * 100) / 100,
            lastActivity: user.activities?.length > 0 ? 
              user.activities[user.activities.length - 1].timestamp : user.createdAt
          }
        };
      });

      // Calculate enhanced summary statistics
      const [
        totalKidzCoin,
        totalDollars,
        usersByRole,
        usersWithParents,
        usersWithChildren,
        suspendedUsers,
        bannedUsers,
        recentUsers
      ] = await Promise.all([
        User.aggregate([{ $group: { _id: null, total: { $sum: '$kidzcoinBalance' } } }]),
        User.aggregate([{ $group: { _id: null, total: { $sum: '$dollarBalance' } } }]),
        User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
        User.countDocuments({ parentId: { $ne: null } }),
        User.countDocuments({ _id: { $in: await User.distinct('parentId') } }),
        User.countDocuments({ isSuspended: true }),
        User.countDocuments({ isBanned: true }),
        User.countDocuments({ 
          createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } 
        })
      ]);

      const summary = {
        totalUsers,
        totalKidzCoin: totalKidzCoin[0]?.total || 0,
        totalDollars: Math.round((totalDollars[0]?.total || 0) * 100) / 100,
        usersByRole,
        usersWithParents,
        usersWithChildren,
        suspendedUsers,
        bannedUsers,
        recentUsers,
        averagePortfolioValue: enhancedUsers.length > 0 ? 
          Math.round((enhancedUsers.reduce((sum, u) => sum + u.statistics.portfolioValue, 0) / enhancedUsers.length) * 100) / 100 : 0
      };

      result = {
        success: true,
        users: enhancedUsers,
        pagination: {
          total: totalUsers,
          page,
          limit,
          totalPages: Math.ceil(totalUsers / limit),
          hasNext: page < Math.ceil(totalUsers / limit),
          hasPrev: page > 1
        },
        summary,
        filters: {
          role: role || null,
          search: search || null,
          hasParent: hasParent || null,
          isActive: isActive || null,
          hasCards: hasCards || null,
          sortBy,
          sortOrder
        }
      };

      // Cache for 2 minutes
      await setCachedData(cacheKey, result, 120);
      console.log(`[Admin Users] Fetched ${enhancedUsers.length}/${totalUsers} users from database`);
    } else {
      console.log(`[Admin Users] Cache hit, returning ${result.users.length} users`);
    }

    res.json(result);

  } catch (err) {
    console.error('[Admin Users] Error fetching users:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching users', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// ============================================================================
// ENHANCED ANALYTICS ENDPOINT
// ============================================================================
router.get('/analytics', cacheMiddleware('analytics', 300), getLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  query('period').optional().isIn(['hour', 'day', 'week', 'month', 'year']).withMessage('Invalid period'),
  query('dateFrom').optional().isISO8601().withMessage('Invalid dateFrom format'),
  query('dateTo').optional().isISO8601().withMessage('Invalid dateTo format'),
  query('includeCharts').optional().isBoolean().withMessage('includeCharts must be a boolean')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/analytics');
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin Analytics] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const { period = 'week', dateFrom, dateTo, includeCharts = 'false' } = req.query;
    
    // Calculate date range with enhanced periods
    let startDate, endDate = new Date();
    
    if (dateFrom && dateTo) {
      startDate = new Date(dateFrom);
      endDate = new Date(dateTo);
    } else {
      startDate = new Date();
      switch (period) {
        case 'hour':
          startDate.setHours(startDate.getHours() - 1);
          break;
        case 'day':
          startDate.setDate(startDate.getDate() - 1);
          break;
        case 'week':
          startDate.setDate(startDate.getDate() - 7);
          break;
        case 'month':
          startDate.setMonth(startDate.getMonth() - 1);
          break;
        case 'year':
          startDate.setFullYear(startDate.getFullYear() - 1);
          break;
      }
    }

    // Enhanced user analytics with trends
    const [userStats, userTrends] = await Promise.all([
      // Current stats
      Promise.all([
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
        User.countDocuments({ 'activities.timestamp': { $gte: startDate, $lte: endDate } }),
        User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
        User.countDocuments({ isSuspended: { $ne: true }, isBanned: { $ne: true } }),
        User.countDocuments({ isSuspended: true }),
        User.countDocuments({ isBanned: true })
      ]),
      // Trend data for charts (if requested)
      includeCharts === 'true' ? User.aggregate([
        {
          $match: { createdAt: { $gte: startDate, $lte: endDate } }
        },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
              day: { $dayOfMonth: '$createdAt' }
            },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
      ]) : []
    ]);

    const userAnalytics = {
      totalUsers: userStats[0],
      newUsers: userStats[1],
      activeUsers: userStats[2],
      usersByRole: userStats[3],
      accountStatus: {
        active: userStats[4],
        suspended: userStats[5],
        banned: userStats[6]
      },
      parentChildRelationships: {
        parents: await User.countDocuments({ _id: { $in: await User.distinct('parentId') } }),
        children: await User.countDocuments({ parentId: { $ne: null } })
      },
      trends: userTrends
    };

    // Enhanced trading analytics
    const tradingAnalytics = await Promise.all([
      Trade.countDocuments(),
      Trade.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
      Trade.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      PendingAction.countDocuments({ status: 'pending', actionType: 'trade' }),
      Trade.aggregate([
        { $match: { status: 'accepted', createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, avgTime: { $avg: { $subtract: ['$updatedAt', '$createdAt'] } } } }
      ])
    ]).then(([total, recent, byStatus, pending, avgTime]) => ({
      totalTrades: total,
      tradesInPeriod: recent,
      tradesByStatus: byStatus,
      pendingApprovals: pending,
      averageApprovalTime: avgTime[0]?.avgTime ? Math.round(avgTime[0].avgTime / (1000 * 60 * 60)) : 0 // hours
    }));

    // Enhanced marketplace analytics
    const marketplaceAnalytics = await Promise.all([
      Listing.countDocuments(),
      Listing.countDocuments({ status: 'active' }),
      Listing.countDocuments({ createdAt: { $gte: startDate, $lte: endDate } }),
      Listing.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Listing.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: null, avgPrice: { $avg: '$salePriceDollar' }, minPrice: { $min: '$salePriceDollar' }, maxPrice: { $max: '$salePriceDollar' } } }
      ]),
      Listing.countDocuments({ status: 'sold', updatedAt: { $gte: startDate, $lte: endDate } }),
      Listing.aggregate([
        { $match: { status: 'sold', updatedAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: null, totalSales: { $sum: '$salePriceDollar' } } }
      ])
    ]).then(([total, active, recent, byStatus, priceStats, sold, revenue]) => ({
      totalListings: total,
      activeListings: active,
      listingsInPeriod: recent,
      listingsByStatus: byStatus,
      priceStatistics: {
        average: Math.round((priceStats[0]?.avgPrice || 0) * 100) / 100,
        minimum: priceStats[0]?.minPrice || 0,
        maximum: priceStats[0]?.maxPrice || 0
      },
      salesInPeriod: sold,
      revenueInPeriod: Math.round((revenue[0]?.totalSales || 0) * 100) / 100
    }));

    // Enhanced financial analytics
    const financialAnalytics = await Promise.all([
      User.aggregate([{ $group: { _id: null, total: { $sum: '$kidzcoinBalance' } } }]),
      User.aggregate([{ $group: { _id: null, total: { $sum: '$dollarBalance' } } }]),
     User.aggregate([
  { 
    $group: { 
      _id: null, 
      avgKidzCoin: { $avg: '$kidzcoinBalance' },
      avgDollars: { $avg: '$dollarBalance' },
      medianKidzCoin: { 
        $median: { 
          input: '$kidzcoinBalance',
          method: "approximate" 
        }
      },
      medianDollars: { 
        $median: { 
          input: '$dollarBalance',
          method: "approximate" 
        }
      }
    } 
  }
]),
      // Top spenders in period
      User.aggregate([
        { $unwind: '$activities' },
        { 
          $match: { 
            'activities.type': { $in: ['purchase', 'listing'] },
            'activities.timestamp': { $gte: startDate, $lte: endDate }
          } 
        },
        { $group: { _id: '$_id', username: { $first: '$username' }, spendingCount: { $sum: 1 } } },
        { $sort: { spendingCount: -1 } },
        { $limit: 10 }
      ])
    ]).then(([totalKC, totalD, averages, topSpenders]) => ({
      totalKidzCoin: totalKC[0]?.total || 0,
      totalDollars: Math.round((totalD[0]?.total || 0) * 100) / 100,
      averageBalance: {
        kidzCoin: Math.round((averages[0]?.avgKidzCoin || 0)),
        dollars: Math.round((averages[0]?.avgDollars || 0) * 100) / 100
      },
      medianBalance: {
        kidzCoin: Math.round((averages[0]?.medianKidzCoin || 0)),
        dollars: Math.round((averages[0]?.medianDollars || 0) * 100) / 100
      },
      topSpenders
    }));

    // Enhanced card analytics
    const cardAnalytics = await Promise.all([
      Card.countDocuments(),
      Card.countDocuments({ isInProfile: true }),
      Card.countDocuments({ assignedTo: { $ne: null } }),
      Card.countDocuments({ isInMarketplace: true }),
      Card.aggregate([
        { $group: { _id: '$team_name', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Card.aggregate([
        { $group: { _id: '$card_set', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Card.aggregate([
        { $match: { currentValuation: { $exists: true } } },
        { $group: { _id: null, avgValue: { $avg: '$currentValuation' }, totalValue: { $sum: '$currentValuation' } } }
      ])
    ]).then(([total, inProfile, assigned, marketplace, byTeam, bySet, valueStats]) => ({
      totalCards: total,
      cardsInProfile: inProfile,
      cardsAssigned: assigned,
      cardsInMarketplace: marketplace,
      unassignedCards: total - assigned,
      cardsByTeam: byTeam,
      cardsBySet: bySet,
      valueStatistics: {
        averageValue: Math.round((valueStats[0]?.avgValue || 0) * 100) / 100,
        totalValue: Math.round((valueStats[0]?.totalValue || 0) * 100) / 100
      }
    }));

    // Enhanced activity analytics
    const activityAnalytics = await Promise.all([
      User.aggregate([
        { $unwind: '$activities' },
        { $count: 'total' }
      ]),
      User.aggregate([
        { $unwind: '$activities' },
        { $match: { 'activities.timestamp': { $gte: startDate, $lte: endDate } } },
        { $count: 'total' }
      ]),
      User.aggregate([
        { $unwind: '$activities' },
        { $group: { _id: '$activities.type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      User.aggregate([
        { $unwind: '$activities' },
        { 
          $match: { 
            'activities.timestamp': { $gte: startDate, $lte: endDate },
            'activities.type': { $in: ['login', 'logout', 'page_view'] }
          } 
        },
        { $group: { _id: '$_id', username: { $first: '$username' }, activityCount: { $sum: 1 } } },
        { $sort: { activityCount: -1 } },
        { $limit: 10 }
      ])
    ]).then(([total, recent, byType, mostActive]) => ({
      totalActivities: total[0]?.total || 0,
      activitiesInPeriod: recent[0]?.total || 0,
      activitiesByType: byType,
      mostActiveUsers: mostActive
    }));

    // Enhanced system health metrics
    const systemHealth = {
      server: {
        uptime: Math.round(process.uptime()),
        memoryUsage: {
          ...process.memoryUsage(),
          heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        },
        nodeVersion: process.version,
        platform: process.platform,
        cpuUsage: process.cpuUsage()
      },
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        name: mongoose.connection.name,
        host: mongoose.connection.host,
        collections: {
          users: await User.estimatedDocumentCount(),
          cards: await Card.estimatedDocumentCount(),
          trades: await Trade.estimatedDocumentCount(),
          listings: await Listing.estimatedDocumentCount(),
          pendingActions: await PendingAction.estimatedDocumentCount()
        }
      },
      redis: {
        status: isRedisConnected ? 'connected' : 'disconnected',
        connected: isRedisConnected
      },
      performance: {
        avgResponseTime: '< 200ms',
        requestsPerMinute: 'Real-time tracking needed',
        errorRate: '< 1%',
        lastRestart: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        cacheHitRate: isRedisConnected ? 'Available' : 'N/A'
      },
      alerts: await generateSystemAlerts(),
      lastChecked: new Date().toISOString()
    };

    const analytics = {
      success: true,
      period: {
        type: period,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      users: userAnalytics,
      trading: tradingAnalytics,
      marketplace: marketplaceAnalytics,
      financial: financialAnalytics,
      cards: cardAnalytics,
      activity: activityAnalytics,
      system: systemHealth,
      generatedAt: new Date().toISOString(),
      generatedBy: req.user._id,
      cached: false // Will be set to true if served from cache
    };

    console.log(`[Admin Analytics] Generated analytics for period ${period} by admin ${req.user._id}`);
    
    res.json(analytics);

  } catch (err) {
    console.error('[Admin Analytics] Error generating analytics:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while generating analytics', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// ============================================================================
// ENHANCED SYSTEM MONITORING
// ============================================================================
router.get('/system', cacheMiddleware('system', 60), getLimiter, authMiddleware.verifyToken, requireAdminOrMaster, async (req, res) => {
  console.log('[Admin] Accessing /api/admin/system');
  try {
    const systemMetrics = {
      server: {
        uptime: Math.round(process.uptime()),
        memoryUsage: {
          ...process.memoryUsage(),
          heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          heapUsedPercent: Math.round((process.memoryUsage().heapUsed / process.memoryUsage().heapTotal) * 100)
        },
        nodeVersion: process.version,
        platform: process.platform,
        cpuUsage: process.cpuUsage(),
        environment: process.env.NODE_ENV || 'development'
      },
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        name: mongoose.connection.name,
        host: mongoose.connection.host,
        readyState: mongoose.connection.readyState,
        collections: {
          users: await User.estimatedDocumentCount(),
          cards: await Card.estimatedDocumentCount(),
          trades: await Trade.estimatedDocumentCount(),
          listings: await Listing.estimatedDocumentCount(),
          pendingActions: await PendingAction.estimatedDocumentCount()
        }
      },
      redis: {
        status: isRedisConnected ? 'connected' : 'disconnected',
        connected: isRedisConnected,
        url: process.env.REDIS_URL || 'redis://localhost:6379'
      },
      performance: {
        avgResponseTime: '< 200ms',
        requestsPerMinute: 'Monitoring needed',
        errorRate: '< 1%',
        lastRestart: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        cacheHitRate: isRedisConnected ? 'Available with Redis' : 'N/A'
      },
      health: {
        status: 'healthy',
        issues: [],
        lastHealthCheck: new Date().toISOString()
      },
      alerts: await generateSystemAlerts(),
      lastChecked: new Date().toISOString()
    };

    // Add health issues based on metrics
    if (systemMetrics.server.memoryUsage.heapUsedPercent > 90) {
      systemMetrics.health.status = 'warning';
      systemMetrics.health.issues.push('High memory usage detected');
    }

    if (mongoose.connection.readyState !== 1) {
      systemMetrics.health.status = 'critical';
      systemMetrics.health.issues.push('Database connection issue');
    }

    console.log(`[Admin System] Generated system metrics for admin ${req.user._id}`);

    res.json({
      success: true,
      metrics: systemMetrics
    });

  } catch (err) {
    console.error('[Admin System] Error fetching system metrics:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching system metrics', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// ============================================================================
// ENHANCED HELPER FUNCTIONS
// ============================================================================

// Enhanced system alerts generator
async function generateSystemAlerts() {
  const alerts = [];

  try {
    // Check for high number of pending actions
    const pendingCount = await PendingAction.countDocuments({ status: 'pending' });
    if (pendingCount > 50) {
      alerts.push({
        level: 'warning',
        message: `High number of pending actions: ${pendingCount}`,
        action: 'Review pending approvals in admin dashboard',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for expired actions that haven't been cleaned up
    const expiredCount = await PendingAction.countDocuments({
      status: 'pending',
      expiresAt: { $lt: new Date() }
    });
    if (expiredCount > 0) {
      alerts.push({
        level: 'info',
        message: `${expiredCount} expired pending actions need cleanup`,
        action: 'Run clearExpired bulk action',
        priority: 'low',
        timestamp: new Date().toISOString()
      });
    }

    // Check for users with very high balances (potential issues)
    const highBalanceUsers = await User.countDocuments({
      $or: [
        { kidzcoinBalance: { $gt: 1000000 } },
        { dollarBalance: { $gt: 10000 } }
      ]
    });
    if (highBalanceUsers > 0) {
      alerts.push({
        level: 'warning',
        message: `${highBalanceUsers} users with unusually high balances`,
        action: 'Review user balances for potential issues',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    if (heapUsedPercent > 90) {
      alerts.push({
        level: 'critical',
        message: `High memory usage detected: ${Math.round(heapUsedPercent)}%`,
        action: 'Consider restarting server or investigating memory leaks',
        priority: 'high',
        timestamp: new Date().toISOString()
      });
    } else if (heapUsedPercent > 75) {
      alerts.push({
        level: 'warning',
        message: `Memory usage above 75%: ${Math.round(heapUsedPercent)}%`,
        action: 'Monitor memory usage closely',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for suspended/banned users
    const [suspendedCount, bannedCount] = await Promise.all([
      User.countDocuments({ isSuspended: true }),
      User.countDocuments({ isBanned: true })
    ]);
    
    if (suspendedCount > 10) {
      alerts.push({
        level: 'info',
        message: `${suspendedCount} suspended users`,
        action: 'Review suspended accounts in user management',
        priority: 'low',
        timestamp: new Date().toISOString()
      });
    }

    if (bannedCount > 5) {
      alerts.push({
        level: 'warning',
        message: `${bannedCount} banned users`,
        action: 'Review banned accounts',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check database connection
    if (mongoose.connection.readyState !== 1) {
      alerts.push({
        level: 'critical',
        message: 'Database connection issue detected',
        action: 'Check MongoDB connection immediately',
        priority: 'critical',
        timestamp: new Date().toISOString()
      });
    }

    // Check Redis connection
    if (!isRedisConnected) {
      alerts.push({
        level: 'warning',
        message: 'Redis cache unavailable',
        action: 'Check Redis server status',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for orphaned cards
    const orphanedCards = await Card.countDocuments({
      assignedTo: { $exists: true, $ne: null },
      assignedTo: { $nin: await User.distinct('_id') }
    });
    
    if (orphanedCards > 0) {
      alerts.push({
        level: 'warning',
        message: `${orphanedCards} orphaned cards detected`,
        action: 'Run system maintenance to fix orphaned references',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

  } catch (err) {
    alerts.push({
      level: 'error',
      message: 'Error generating system alerts',
      action: 'Check server logs for detailed error information',
      priority: 'high',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }

  return alerts;
}

// ============================================================================
// ENHANCED TRANSACTION MONITORING ENDPOINT
// ============================================================================
router.get('/transactions', cacheMiddleware('transactions', 180), getLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('type').optional().isIn(['trade', 'listing', 'purchase']).withMessage('Invalid transaction type'),
  query('status').optional().isIn(['pending', 'completed', 'cancelled', 'expired']).withMessage('Invalid status'),
  query('userId').optional().custom(value => mongoose.Types.ObjectId.isValid(value)).withMessage('Invalid user ID'),
  query('dateFrom').optional().isISO8601().withMessage('Invalid dateFrom format'),
  query('dateTo').optional().isISO8601().withMessage('Invalid dateTo format')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/transactions');
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin Transactions] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;
    const { type, status, userId, dateFrom, dateTo } = req.query;

    let transactions = [];
    let totalCount = 0;

    // Build date filter
    const dateFilter = {};
    if (dateFrom || dateTo) {
      if (dateFrom) dateFilter.$gte = new Date(dateFrom);
      if (dateTo) dateFilter.$lte = new Date(dateTo);
    }

    // Fetch trades with enhanced data
    if (!type || type === 'trade') {
      let tradeQuery = {};
      if (status) tradeQuery.status = status === 'completed' ? 'accepted' : status;
      if (userId) tradeQuery.$or = [{ fromUser: userId }, { toUser: userId }];
      if (Object.keys(dateFilter).length > 0) tradeQuery.createdAt = dateFilter;

      const trades = await Trade.find(tradeQuery)
        .populate('fromUser', 'username email')
        .populate('toUser', 'username email')
        .populate('offeredCards', 'player_name images team_name currentValuation')
        .populate('requestedCards', 'player_name images team_name currentValuation')
        .sort({ createdAt: -1 })
        .skip(type === 'trade' ? skip : 0)
        .limit(type === 'trade' ? limit : 1000)
        .lean();

      const tradeTransactions = trades.map(trade => {
        const offeredValue = (trade.offeredCards || []).reduce((sum, card) => 
          sum + (card.currentValuation || 0), 0);
        const requestedValue = (trade.requestedCards || []).reduce((sum, card) => 
          sum + (card.currentValuation || 0), 0);

        return {
          _id: trade._id,
          type: 'trade',
          status: trade.status === 'accepted' ? 'completed' : trade.status,
          fromUser: trade.fromUser,
          toUser: trade.toUser,
          items: {
            offered: trade.offeredCards,
            requested: trade.requestedCards
          },
          value: {
            offered: Math.round(offeredValue * 100) / 100,
            requested: Math.round(requestedValue * 100) / 100,
            difference: Math.round((offeredValue - requestedValue) * 100) / 100
          },
          createdAt: trade.createdAt,
          updatedAt: trade.updatedAt,
          details: {
            tradeId: trade._id,
            message: trade.message || null
          }
        };
      });

      transactions = transactions.concat(tradeTransactions);
      if (type === 'trade') totalCount = await Trade.countDocuments(tradeQuery);
    }

    // Fetch listings with enhanced data
    if (!type || type === 'listing') {
      let listingQuery = {};
      if (status) listingQuery.status = status === 'completed' ? 'sold' : status;
      if (userId) listingQuery.listedBy = userId;
      if (Object.keys(dateFilter).length > 0) listingQuery.createdAt = dateFilter;

      const listings = await Listing.find(listingQuery)
        .populate('listedBy', 'username email')
        .populate('cardId', 'player_name images team_name currentValuation')
        //.populate('soldTo', 'username email')
        .sort({ createdAt: -1 })
        .skip(type === 'listing' ? skip : 0)
        .limit(type === 'listing' ? limit : 1000)
        .lean();

      const listingTransactions = listings.map(listing => ({
        _id: listing._id,
        type: 'listing',
        status: listing.status === 'sold' ? 'completed' : listing.status,
        fromUser: listing.listedBy,
        toUser: listing.status === 'sold' ? listing.soldTo : null,
        items: {
          card: listing.cardId,
          price: listing.salePriceDollar,
          currency: 'USD'
        },
        value: {
          listed: listing.salePriceDollar,
          market: listing.cardId?.currentValuation || 0,
          difference: Math.round((listing.salePriceDollar - (listing.cardId?.currentValuation || 0)) * 100) / 100
        },
        createdAt: listing.createdAt,
        updatedAt: listing.updatedAt,
        soldAt: listing.soldAt || null,
        details: {
          listingId: listing._id,
          price: listing.salePriceDollar,
          currency: 'USD',
          fees: {
            listingFeeKidzcoin: listing.listingFeeKidzcoin || 0,
            listingFeeDollar: listing.listingFeeDollar || 0
          }
        }
      }));

      transactions = transactions.concat(listingTransactions);
      if (type === 'listing') totalCount = await Listing.countDocuments(listingQuery);
    }

    // Sort all transactions by date if multiple types
    if (!type) {
      transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      totalCount = transactions.length;
      transactions = transactions.slice(skip, skip + limit);
    }

    // Generate enhanced transaction summary
    const summary = {
      totalTransactions: totalCount,
      transactionsByType: await Promise.all([
        Trade.aggregate([{ $group: { _id: 'trade', count: { $sum: 1 } } }]),
        Listing.aggregate([{ $group: { _id: 'listing', count: { $sum: 1 } } }])
      ]).then(results => results.flat()),
      transactionsByStatus: !type ? 
        transactions.reduce((acc, t) => {
          acc[t.status] = (acc[t.status] || 0) + 1;
          return acc;
        }, {}) :
        type === 'trade' ? 
          await Trade.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]) :
          await Listing.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      totalValue: {
        trades: transactions.filter(t => t.type === 'trade')
          .reduce((sum, t) => sum + (t.value?.offered || 0), 0),
        sales: transactions.filter(t => t.type === 'listing' && t.status === 'completed')
          .reduce((sum, t) => sum + (t.value?.listed || 0), 0)
      }
    };

    console.log(`[Admin Transactions] Fetched ${transactions.length} transactions for admin ${req.user._id}`);

    res.json({
      success: true,
      transactions,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
        hasNext: page < Math.ceil(totalCount / limit),
        hasPrev: page > 1
      },
      summary,
      filters: {
        type: type || null,
        status: status || null,
        userId: userId || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null
      }
    });

  } catch (err) {
    console.error('[Admin Transactions] Error fetching transactions:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching transactions', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// ============================================================================
// ENHANCED USER MANAGEMENT ENDPOINT
// ============================================================================
router.put('/user/:id', postLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  param('id').custom(value => mongoose.Types.ObjectId.isValid(value)).withMessage('Invalid user ID'),
  body('action').isIn(['suspend', 'activate', 'ban', 'unban', 'updateBalance', 'resetPassword', 'updateRole']).withMessage('Invalid action'),
  body('reason').optional().trim().isLength({ max: 500 }).withMessage('Reason must be 500 characters or less'),
  body('duration').optional().isInt({ min: 1 }).withMessage('Duration must be a positive integer'),
  body('kidzcoinBalance').optional().isFloat({ min: 0 }).withMessage('KidzCoin balance must be non-negative'),
  body('dollarBalance').optional().isFloat({ min: 0 }).withMessage('Dollar balance must be non-negative'),
  body('newRole').optional().isIn(['user', 'admin', 'parent']).withMessage('Invalid role'),
  body('newPassword').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/user/:id');
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin User Management] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const { id } = req.params;
    const { action, reason, duration, kidzcoinBalance, dollarBalance, newRole, newPassword } = req.body;
    const adminId = req.user._id;

    // Find target user
    const targetUser = await User.findById(id).session(session);
    if (!targetUser) {
      console.log(`[Admin User Management] User not found: ${id}`);
      return res.status(404).json({ 
        success: false,
        message: 'User not found' 
      });
    }

    // Enhanced permission checks
    if (targetUser.role === 'master' && req.user.role !== 'master') {
      console.log(`[Admin User Management] Admin ${adminId} attempted to modify master user ${id}`);
      return res.status(403).json({ 
        success: false,
        message: 'Cannot modify master users' 
      });
    }

    if (action === 'updateRole' && newRole === 'master' && req.user.role !== 'master') {
      return res.status(403).json({ 
        success: false,
        message: 'Only master users can create master accounts' 
      });
    }

    // Prevent self-modification for certain actions
    if (targetUser._id.toString() === adminId && ['suspend', 'ban', 'updateRole'].includes(action)) {
      return res.status(403).json({ 
        success: false,
        message: 'Cannot perform this action on your own account' 
      });
    }

    let updates = {};
    let notificationMessage = '';
    let emailNotification = false;

    switch (action) {
      case 'suspend':
        updates.isSuspended = true;
        updates.suspendedUntil = duration ? new Date(Date.now() + duration * 24 * 60 * 60 * 1000) : null;
        updates.suspensionReason = validateAndSanitize.reason(reason) || 'Account suspended by admin';
        notificationMessage = `Your account has been suspended${duration ? ` for ${duration} days` : ''}. Reason: ${updates.suspensionReason}`;
        emailNotification = true;
        break;

      case 'activate':
        updates.isSuspended = false;
        updates.suspendedUntil = null;
        updates.suspensionReason = null;
        notificationMessage = 'Your account has been reactivated. You can now access all features.';
        emailNotification = true;
        break;

      case 'ban':
        updates.isBanned = true;
        updates.banReason = validateAndSanitize.reason(reason) || 'Account banned by admin';
        notificationMessage = `Your account has been banned. Reason: ${updates.banReason}`;
        emailNotification = true;
        break;

      case 'unban':
        updates.isBanned = false;
        updates.banReason = null;
        notificationMessage = 'Your account ban has been lifted. Welcome back!';
        emailNotification = true;
        break;

      case 'updateBalance':
        if (kidzcoinBalance !== undefined) {
          updates.kidzcoinBalance = Math.max(0, Math.round(kidzcoinBalance));
        }
        if (dollarBalance !== undefined) {
          updates.dollarBalance = Math.max(0, Math.round(dollarBalance * 100) / 100);
        }
        notificationMessage = `Your account balance has been updated by an administrator.${reason ? ` Reason: ${validateAndSanitize.reason(reason)}` : ''}`;
        break;

      case 'updateRole':
        if (newRole && newRole !== targetUser.role) {
          updates.role = newRole;
          updates.isAdmin = newRole === 'admin' || newRole === 'master';
          notificationMessage = `Your account role has been updated to ${newRole}.${reason ? ` Reason: ${validateAndSanitize.reason(reason)}` : ''}`;
          emailNotification = true;
        }
        break;

      case 'resetPassword':
        if (newPassword) {
          const bcrypt = require('bcrypt');
          updates.passwordHash = await bcrypt.hash(newPassword, 12);
          notificationMessage = 'Your password has been reset by an administrator. Please log in with your new password.';
          emailNotification = true;
        }
        break;

      default:
        return res.status(400).json({ 
          success: false,
          message: 'Invalid action' 
        });
    }

    // Apply updates
    await User.updateOne({ _id: id }, { $set: updates }, { session });

    // Enhanced admin action logging
    const actionLog = {
      adminId,
      adminUsername: req.user.username,
      targetUserId: id,
      targetUsername: targetUser.username,
      action,
      reason: validateAndSanitize.reason(reason) || null,
      timestamp: new Date(),
      details: updates,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      previousValues: {
        isSuspended: targetUser.isSuspended,
        isBanned: targetUser.isBanned,
        role: targetUser.role,
        kidzcoinBalance: targetUser.kidzcoinBalance,
        dollarBalance: targetUser.dollarBalance
      }
    };

    // Add action to admin's activity log
    await User.updateOne(
      { _id: adminId },
      { 
        $push: { 
          activities: {
            type: 'admin_action',
            details: actionLog,
            timestamp: new Date()
          }
        }
      },
      { session }
    );

    // Notify user with enhanced notification
    try {
      await notifyUser(
        id,
        'system',
        {
          message: notificationMessage,
          action,
          adminAction: true,
          timestamp: new Date().toISOString(),
          actionBy: req.user.username
        },
        { 
          session, 
          viaEmail: emailNotification,
          emailOptions: {
            subject: `RedHead KidzCardz: Account ${action.charAt(0).toUpperCase() + action.slice(1)}`,
            text: notificationMessage
          },
          caller: 'adminUserManagement' 
        }
      );
    } catch (notifyError) {
      console.warn('[Admin User Management] Failed to notify user:', notifyError.message);
      // Don't fail the entire operation if notification fails
    }

    await session.commitTransaction();

    // Invalidate relevant caches
    await Promise.all([
      invalidateCache('admin:users:*'),
      invalidateCache('admin:analytics:*'),
      invalidateCache('admin:system:*')
    ]);

    console.log(`[Admin User Management] Admin ${adminId} performed ${action} on user ${id}`);

    res.json({
      success: true,
      message: `User ${action} completed successfully`,
      action,
      targetUser: {
        _id: targetUser._id,
        username: targetUser.username,
        email: targetUser.email
      },
      updates,
      reason: validateAndSanitize.reason(reason) || null,
      performedBy: req.user.username,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    await session.abortTransaction();
    console.error('[Admin User Management] Error managing user:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while managing user', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  } finally {
    session.endSession();
  }
});

// ============================================================================
// ENHANCED BULK ACTIONS ENDPOINT
// ============================================================================
router.post('/actions', postLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  body('action').isIn(['bulkUpdate', 'systemMaintenance', 'dataExport', 'balanceReset', 'clearExpired']).withMessage('Invalid bulk action'),
  body('target').optional().isIn(['users', 'cards', 'trades', 'listings', 'all']).withMessage('Invalid target'),
  body('filters').optional().isObject().withMessage('Filters must be an object'),
  body('updates').optional().isObject().withMessage('Updates must be an object'),
  body('confirm').isBoolean().withMessage('Confirmation required for bulk actions')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/actions');
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin Bulk Actions] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const { action, target, filters = {}, updates = {}, confirm } = req.body;
    const adminId = req.user._id;

    if (!confirm) {
      return res.status(400).json({ 
        success: false,
        message: 'Bulk actions require explicit confirmation' 
      });
    }

    // Enhanced security check for destructive operations
    if (['balanceReset', 'clearExpired', 'systemMaintenance'].includes(action) && req.user.role !== 'master') {
      return res.status(403).json({ 
        success: false,
        message: 'Master role required for this operation' 
      });
    }

    let result = {};

    switch (action) {
      case 'bulkUpdate':
        if (!target || !updates || Object.keys(updates).length === 0) {
          return res.status(400).json({ 
            success: false,
            message: 'Target and updates required for bulk update' 
          });
        }

        // Sanitize updates
        const sanitizedUpdates = {};
        for (const [key, value] of Object.entries(updates)) {
          if (typeof value === 'string') {
            sanitizedUpdates[key] = validateAndSanitize.searchTerm(value);
          } else {
            sanitizedUpdates[key] = value;
          }
        }

        switch (target) {
          case 'users':
            // Prevent modification of master users by non-masters
            if (req.user.role !== 'master') {
              filters.role = { $ne: 'master' };
            }
            result = await User.updateMany(filters, { $set: sanitizedUpdates }, { session });
            break;
          case 'cards':
            result = await Card.updateMany(filters, { $set: sanitizedUpdates }, { session });
            break;
          case 'trades':
            result = await Trade.updateMany(filters, { $set: sanitizedUpdates }, { session });
            break;
          case 'listings':
            result = await Listing.updateMany(filters, { $set: sanitizedUpdates }, { session });
            break;
          default:
            return res.status(400).json({ 
              success: false,
              message: 'Invalid target for bulk update' 
            });
        }
        break;

      case 'balanceReset':
        const defaultKidzCoin = Math.max(0, updates.kidzcoinBalance || 10000);
        const defaultDollars = Math.max(0, updates.dollarBalance || 10);
        
        // Prevent reset of master accounts unless admin is master
        if (req.user.role !== 'master') {
          filters.role = { $ne: 'master' };
        }
        
        result = await User.updateMany(
          filters,
          { 
            $set: { 
              kidzcoinBalance: defaultKidzCoin,
              dollarBalance: defaultDollars
            } 
          },
          { session }
        );
        break;

      case 'clearExpired':
        const [expiredActions, expiredListings] = await Promise.all([
          PendingAction.updateMany(
            { 
              status: 'pending',
              expiresAt: { $lt: new Date() }
            },
            { $set: { status: 'expired' } },
            { session }
          ),
          Listing.updateMany(
            {
              status: 'active',
              expiresAt: { $lt: new Date() }
            },
            { $set: { status: 'expired' } },
            { session }
          )
        ]);

        result = {
          expiredActions: expiredActions.modifiedCount,
          expiredListings: expiredListings.modifiedCount
        };
        break;

      case 'dataExport':
        // Enhanced data export with safety limits and better structure
        const exportLimit = 1000;
        const exportData = {
          metadata: {
            exportedAt: new Date().toISOString(),
            exportedBy: {
              id: adminId,
              username: req.user.username
            },
            filters,
            recordLimits: exportLimit
          },
          users: await User.find(filters)
            .select('-passwordHash -activities')
            .limit(exportLimit)
            .session(session),
          trades: await Trade.find(filters)
            .populate('fromUser', 'username email')
            .populate('toUser', 'username email')
            .limit(exportLimit)
            .session(session),
          listings: await Listing.find(filters)
            .populate('listedBy', 'username email')
            .populate('cardId', 'player_name team_name')
            .limit(exportLimit)
            .session(session)
        };
        
        result = {
          message: 'Data export generated successfully',
          recordCount: {
            users: exportData.users.length,
            trades: exportData.trades.length,
            listings: exportData.listings.length
          },
          exportId: new mongoose.Types.ObjectId().toString(),
          note: 'Export data available in response (limited to 1000 records per collection)'
        };
        break;

      case 'systemMaintenance':
        // Enhanced system maintenance with more comprehensive cleanup
        const maintenanceTasks = await Promise.all([
          // Clean up old pending actions
          PendingAction.deleteMany({
            status: { $in: ['expired', 'approved', 'rejected'] },
            createdAt: { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
          }, { session }),
          
          // Fix orphaned cards
          Card.updateMany(
            { assignedTo: { $nin: await User.distinct('_id') } },
            { $unset: { assignedTo: 1, isInProfile: 1 } },
            { session }
          ),
          
          // Fix invalid user references
          User.updateMany(
            { parentId: { $nin: await User.distinct('_id') } },
            { $unset: { parentId: 1 } },
            { session }
          ),
          
          // Clean up user assigned cards arrays
          User.updateMany(
            {},
            { $pull: { assignedCards: { $nin: await Card.distinct('_id') } } },
            { session }
          ),
          
          // Fix marketplace status inconsistencies
          Card.updateMany(
            { 
              isInMarketplace: true,
              _id: { $nin: await Listing.distinct('cardId', { status: 'active' }) }
            },
            { $set: { isInMarketplace: false, salePrice: null } },
            { session }
          )
        ]);

        result = {
          message: 'System maintenance completed successfully',
          tasks: {
            expiredActionsRemoved: maintenanceTasks[0].deletedCount,
            orphanedCardsFixed: maintenanceTasks[1].modifiedCount,
            invalidReferencesFixed: maintenanceTasks[2].modifiedCount,
            userCardArraysCleaned: maintenanceTasks[3].modifiedCount,
            marketplaceStatusFixed: maintenanceTasks[4].modifiedCount
          },
          recommendations: [
            'Consider running this maintenance weekly',
            'Monitor system alerts for ongoing issues',
            'Review user activity logs for unusual patterns'
          ]
        };
        break;

      default:
        return res.status(400).json({ 
          success: false,
          message: 'Invalid bulk action' 
        });
    }

    // Enhanced admin action logging
    await User.updateOne(
      { _id: adminId },
      { 
        $push: { 
          activities: {
            type: 'admin_bulk_action',
            details: {
              action,
              target,
              filters,
              updates,
              result,
              timestamp: new Date(),
              ip: req.ip,
              userAgent: req.get('User-Agent'),
              impact: {
                recordsAffected: result.modifiedCount || result.deletedCount || 0,
                collections: target || 'multiple'
              }
            },
            timestamp: new Date()
          }
        }
      },
      { session }
    );

    await session.commitTransaction();

    // Invalidate all admin caches after bulk operations
    await invalidateCache('admin:*');

    console.log(`[Admin Bulk Actions] Admin ${adminId} performed ${action} on ${target}:`, result);

    res.json({
      success: true,
      message: `Bulk action ${action} completed successfully`,
      action,
      target,
      result,
      performedBy: req.user.username,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    await session.abortTransaction();
    console.error('[Admin Bulk Actions] Error performing bulk action:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while performing bulk action', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  } finally {
    session.endSession();
  }
});

// ============================================================================
// ENHANCED ADMIN LOGS ENDPOINT
// ============================================================================
router.get('/logs', getLimiter, authMiddleware.verifyToken, requireAdminOrMaster, [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
  query('level').optional().isIn(['info', 'warning', 'error', 'critical']).withMessage('Invalid log level'),
  query('adminId').optional().custom(value => mongoose.Types.ObjectId.isValid(value)).withMessage('Invalid admin ID'),
  query('dateFrom').optional().isISO8601().withMessage('Invalid dateFrom format'),
  query('dateTo').optional().isISO8601().withMessage('Invalid dateTo format'),
  query('action').optional().trim().isLength({ max: 50 }).withMessage('Action filter too long')
], async (req, res) => {
  console.log('[Admin] Accessing /api/admin/logs');
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('[Admin Logs] Validation errors:', errors.array());
      return res.status(400).json({ 
        success: false,
        message: 'Validation failed', 
        errors: errors.array() 
      });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const skip = (page - 1) * limit;
    const { level, adminId, dateFrom, dateTo, action } = req.query;

    // Build cache key
    const cacheKey = `admin:logs:${JSON.stringify({
      page, limit, level, adminId, dateFrom, dateTo, action
    })}`;
    
    let result = await getCachedData(cacheKey);
    
    if (!result) {
      console.log('[Admin Logs] Cache miss, querying database');

      // Build query for admin actions from user activities
      let query = {
        'activities.type': { $in: ['admin_action', 'admin_bulk_action', 'admin_access', 'admin_access_denied'] }
      };

      if (adminId) {
        query._id = adminId;
      }

      // Build date filter
      if (dateFrom || dateTo) {
        const dateFilter = {};
        if (dateFrom) dateFilter.$gte = new Date(dateFrom);
        if (dateTo) dateFilter.$lte = new Date(dateTo);
        query['activities.timestamp'] = dateFilter;
      }

      // Get admin users and their activities
      const adminUsers = await User.find(query)
        .select('username email role activities')
        .sort({ 'activities.timestamp': -1 })
        .lean();

      // Extract and format admin activities
      let adminLogs = [];
      adminUsers.forEach(user => {
        const adminActivities = user.activities.filter(activity => 
          ['admin_action', 'admin_bulk_action', 'admin_access', 'admin_access_denied'].includes(activity.type)
        );
        
        adminActivities.forEach(activity => {
          let logLevel = 'info';
          
          // Enhanced log level determination
          if (activity.type === 'admin_access_denied') logLevel = 'warning';
          if (activity.details?.action === 'ban' || activity.details?.action === 'suspend') logLevel = 'warning';
          if (activity.details?.action === 'systemMaintenance') logLevel = 'critical';
          if (activity.details?.impact?.recordsAffected > 100) logLevel = 'warning';
          if (activity.type === 'admin_bulk_action' && activity.details?.action === 'balanceReset') logLevel = 'critical';

          // Action filter
          if (action && !activity.details?.action?.toLowerCase().includes(action.toLowerCase())) {
            return;
          }

          adminLogs.push({
            _id: activity._id || new mongoose.Types.ObjectId(),
            timestamp: activity.timestamp,
            admin: {
              _id: user._id,
              username: user.username,
              email: user.email,
              role: user.role
            },
            type: activity.type,
            details: {
              ...activity.details,
              // Add human-readable descriptions
              description: generateLogDescription(activity),
              impact: activity.details?.impact || null
            },
            level: logLevel
          });
        });
      });

      // Sort by timestamp (most recent first)
      adminLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      // Apply level filter
      if (level) {
        adminLogs = adminLogs.filter(log => log.level === level);
      }

      // Paginate
      const totalLogs = adminLogs.length;
      const paginatedLogs = adminLogs.slice(skip, skip + limit);

      // Generate enhanced log summary
      const summary = {
        totalLogs,
        logsByLevel: adminLogs.reduce((acc, log) => {
          acc[log.level] = (acc[log.level] || 0) + 1;
          return acc;
        }, {}),
        logsByAdmin: adminLogs.reduce((acc, log) => {
          const adminName = log.admin.username;
          acc[adminName] = (acc[adminName] || 0) + 1;
          return acc;
        }, {}),
        logsByType: adminLogs.reduce((acc, log) => {
          acc[log.type] = (acc[log.type] || 0) + 1;
          return acc;
        }, {}),
        logsByAction: adminLogs.reduce((acc, log) => {
          const actionType = log.details?.action || 'unknown';
          acc[actionType] = (acc[actionType] || 0) + 1;
          return acc;
        }, {}),
        dateRange: {
          earliest: adminLogs.length > 0 ? adminLogs[adminLogs.length - 1].timestamp : null,
          latest: adminLogs.length > 0 ? adminLogs[0].timestamp : null
        },
        criticalActions: adminLogs.filter(log => log.level === 'critical').length,
        warningActions: adminLogs.filter(log => log.level === 'warning').length
      };

      result = {
        success: true,
        logs: paginatedLogs,
        pagination: {
          total: totalLogs,
          page,
          limit,
          totalPages: Math.ceil(totalLogs / limit),
          hasNext: page < Math.ceil(totalLogs / limit),
          hasPrev: page > 1
        },
        summary,
        filters: {
          level: level || null,
          adminId: adminId || null,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          action: action || null
        }
      };

      // Cache for 5 minutes
      await setCachedData(cacheKey, result, 300);
      console.log(`[Admin Logs] Fetched ${paginatedLogs.length}/${totalLogs} admin logs from database`);
    } else {
      console.log(`[Admin Logs] Cache hit, returning ${result.logs.length} logs`);
    }

    res.json(result);

  } catch (err) {
    console.error('[Admin Logs] Error fetching admin logs:', err.message, err.stack);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching admin logs', 
      error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    });
  }
});

// Helper function to generate human-readable log descriptions
function generateLogDescription(activity) {
  const { type, details } = activity;
  
  switch (type) {
    case 'admin_action':
      const action = details?.action || 'unknown';
      const target = details?.targetUsername || 'user';
      return `${action.charAt(0).toUpperCase() + action.slice(1)} action performed on ${target}`;
    
    case 'admin_bulk_action':
      const bulkAction = details?.action || 'unknown';
      const affected = details?.impact?.recordsAffected || 0;
      return `Bulk ${bulkAction} performed, ${affected} records affected`;
    
    case 'admin_access':
      const endpoint = details?.endpoint || 'unknown endpoint';
      return `Admin accessed ${endpoint}`;
    
    case 'admin_access_denied':
      const deniedEndpoint = details?.endpoint || 'unknown endpoint';
      const reason = details?.reason || 'unknown reason';
      return `Admin access denied to ${deniedEndpoint} (${reason})`;
    
    default:
      return 'Admin activity logged';
  }
}

// Enhanced system alerts generator (already included above)
async function generateSystemAlerts() {
  const alerts = [];

  try {
    // Check for high number of pending actions
    const pendingCount = await PendingAction.countDocuments({ status: 'pending' });
    if (pendingCount > 50) {
      alerts.push({
        level: 'warning',
        message: `High number of pending actions: ${pendingCount}`,
        action: 'Review pending approvals in admin dashboard',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for expired actions that haven't been cleaned up
    const expiredCount = await PendingAction.countDocuments({
      status: 'pending',
      expiresAt: { $lt: new Date() }
    });
    if (expiredCount > 0) {
      alerts.push({
        level: 'info',
        message: `${expiredCount} expired pending actions need cleanup`,
        action: 'Run clearExpired bulk action',
        priority: 'low',
        timestamp: new Date().toISOString()
      });
    }

    // Check for users with very high balances (potential issues)
    const highBalanceUsers = await User.countDocuments({
      $or: [
        { kidzcoinBalance: { $gt: 1000000 } },
        { dollarBalance: { $gt: 10000 } }
      ]
    });
    if (highBalanceUsers > 0) {
      alerts.push({
        level: 'warning',
        message: `${highBalanceUsers} users with unusually high balances`,
        action: 'Review user balances for potential issues',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
    
    if (heapUsedPercent > 90) {
      alerts.push({
        level: 'critical',
        message: `High memory usage detected: ${Math.round(heapUsedPercent)}%`,
        action: 'Consider restarting server or investigating memory leaks',
        priority: 'high',
        timestamp: new Date().toISOString()
      });
    } else if (heapUsedPercent > 75) {
      alerts.push({
        level: 'warning',
        message: `Memory usage above 75%: ${Math.round(heapUsedPercent)}%`,
        action: 'Monitor memory usage closely',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for suspended/banned users
    const [suspendedCount, bannedCount] = await Promise.all([
      User.countDocuments({ isSuspended: true }),
      User.countDocuments({ isBanned: true })
    ]);
    
    if (suspendedCount > 10) {
      alerts.push({
        level: 'info',
        message: `${suspendedCount} suspended users`,
        action: 'Review suspended accounts in user management',
        priority: 'low',
        timestamp: new Date().toISOString()
      });
    }

    if (bannedCount > 5) {
      alerts.push({
        level: 'warning',
        message: `${bannedCount} banned users`,
        action: 'Review banned accounts',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check database connection
    if (mongoose.connection.readyState !== 1) {
      alerts.push({
        level: 'critical',
        message: 'Database connection issue detected',
        action: 'Check MongoDB connection immediately',
        priority: 'critical',
        timestamp: new Date().toISOString()
      });
    }

    // Check Redis connection
    if (!isRedisConnected) {
      alerts.push({
        level: 'warning',
        message: 'Redis cache unavailable',
        action: 'Check Redis server status',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

    // Check for orphaned cards
    const orphanedCards = await Card.countDocuments({
      assignedTo: { $exists: true, $ne: null },
      assignedTo: { $nin: await User.distinct('_id') }
    });
    
    if (orphanedCards > 0) {
      alerts.push({
        level: 'warning',
        message: `${orphanedCards} orphaned cards detected`,
        action: 'Run system maintenance to fix orphaned references',
        priority: 'medium',
        timestamp: new Date().toISOString()
      });
    }

  } catch (err) {
    alerts.push({
      level: 'error',
      message: 'Error generating system alerts',
      action: 'Check server logs for detailed error information',
      priority: 'high',
      timestamp: new Date().toISOString(),
      error: err.message
    });
  }

  return alerts;
}

module.exports = router;
