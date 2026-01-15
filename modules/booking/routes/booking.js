/**
 * Booking Routes - PostgreSQL Version
 * Universal booking system for any business type
 */

const express = require('express');
const router = express.Router();
const db = require('../database/db');

// GET all bookings (with filters)
router.get('/', async (req, res) => {
  try {
    const { status, date, startDate, endDate, userId } = req.query;
    
    let query = 'SELECT * FROM bookings WHERE 1=1';
    const params = [];
    let paramCount = 0;
    
    if (status) {
      paramCount++;
      query += ` AND status = $${paramCount}`;
      params.push(status);
    }
    
    if (userId) {
      paramCount++;
      query += ` AND user_id = $${paramCount}`;
      params.push(userId);
    }
    
    if (date) {
      paramCount++;
      query += ` AND DATE(booking_date) = $${paramCount}`;
      params.push(date);
    } else if (startDate && endDate) {
      paramCount++;
      query += ` AND booking_date >= $${paramCount}`;
      params.push(startDate);
      paramCount++;
      query += ` AND booking_date <= $${paramCount}`;
      params.push(endDate);
    }
    
    query += ' ORDER BY booking_date ASC, start_time ASC';
    
    const result = await db.query(query, params);
    
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('[Booking] Error fetching bookings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bookings'
    });
  }
});

// GET single booking
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM bookings WHERE id = $1',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[Booking] Error fetching booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch booking'
    });
  }
});

// GET available time slots for a date
router.get('/slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    
    // Get business hours (configurable)
    const businessHours = {
      open: '09:00',
      close: '18:00',
      slotDuration: 60 // minutes
    };
    
    // Get booked slots for this date
    const bookedResult = await db.query(
      `SELECT start_time, end_time FROM bookings 
       WHERE DATE(booking_date) = $1 AND status != 'cancelled'`,
      [date]
    );
    
    const bookedTimes = bookedResult.rows.map(b => b.start_time);
    
    // Generate available slots
    const slots = [];
    let currentTime = businessHours.open;
    
    while (currentTime < businessHours.close) {
      if (!bookedTimes.includes(currentTime)) {
        slots.push({
          time: currentTime,
          available: true
        });
      }
      
      // Increment by slot duration
      const [hours, mins] = currentTime.split(':').map(Number);
      const totalMins = hours * 60 + mins + businessHours.slotDuration;
      const newHours = Math.floor(totalMins / 60);
      const newMins = totalMins % 60;
      currentTime = `${String(newHours).padStart(2, '0')}:${String(newMins).padStart(2, '0')}`;
    }
    
    res.json({
      success: true,
      date,
      businessHours,
      slots,
      bookedCount: bookedTimes.length
    });
  } catch (error) {
    console.error('[Booking] Error fetching slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch available slots'
    });
  }
});

// CREATE new booking
router.post('/', async (req, res) => {
  try {
    const { 
      userId, 
      customerName,
      customerEmail,
      customerPhone,
      serviceType, 
      bookingDate, 
      startTime,
      endTime,
      notes,
      partySize
    } = req.body;
    
    // Check for conflicts
    const conflictResult = await db.query(
      `SELECT id FROM bookings 
       WHERE DATE(booking_date) = $1 
       AND start_time = $2 
       AND status != 'cancelled'`,
      [bookingDate, startTime]
    );
    
    if (conflictResult.rows.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'This time slot is already booked'
      });
    }
    
    // Create booking
    const result = await db.query(
      `INSERT INTO bookings (
        user_id, customer_name, customer_email, customer_phone,
        service_type, booking_date, start_time, end_time, 
        notes, party_size, status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', NOW())
      RETURNING *`,
      [
        userId || null,
        customerName,
        customerEmail,
        customerPhone,
        serviceType || 'general',
        bookingDate,
        startTime,
        endTime || null,
        notes || null,
        partySize || 1
      ]
    );
    
    console.log('[Booking] Created booking:', result.rows[0].id);
    
    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[Booking] Error creating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create booking'
    });
  }
});

// UPDATE booking
router.put('/:id', async (req, res) => {
  try {
    const { serviceType, bookingDate, startTime, endTime, notes, partySize } = req.body;
    
    const result = await db.query(
      `UPDATE bookings SET
        service_type = COALESCE($1, service_type),
        booking_date = COALESCE($2, booking_date),
        start_time = COALESCE($3, start_time),
        end_time = COALESCE($4, end_time),
        notes = COALESCE($5, notes),
        party_size = COALESCE($6, party_size),
        updated_at = NOW()
      WHERE id = $7
      RETURNING *`,
      [serviceType, bookingDate, startTime, endTime, notes, partySize, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Booking updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[Booking] Error updating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update booking'
    });
  }
});

// UPDATE booking status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'cancelled', 'completed', 'no-show'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status'
      });
    }
    
    const result = await db.query(
      `UPDATE bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Booking status updated',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[Booking] Error updating status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update status'
    });
  }
});

// CANCEL booking
router.post('/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body;
    
    const result = await db.query(
      `UPDATE bookings SET 
        status = 'cancelled', 
        cancellation_reason = $1,
        cancelled_at = NOW(),
        updated_at = NOW()
      WHERE id = $2 
      RETURNING *`,
      [reason || null, req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    console.log('[Booking] Cancelled booking:', req.params.id);
    
    res.json({
      success: true,
      message: 'Booking cancelled',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('[Booking] Error cancelling booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel booking'
    });
  }
});

// DELETE booking
router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM bookings WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Booking not found'
      });
    }
    
    res.json({
      success: true,
      message: 'Booking deleted successfully'
    });
  } catch (error) {
    console.error('[Booking] Error deleting booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete booking'
    });
  }
});

// GET user's bookings
router.get('/user/:userId', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM bookings WHERE user_id = $1 ORDER BY booking_date DESC`,
      [req.params.userId]
    );
    
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });
  } catch (error) {
    console.error('[Booking] Error fetching user bookings:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch bookings'
    });
  }
});

module.exports = router;