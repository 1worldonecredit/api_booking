require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Pool } = require('pg'); // <-- ต้องมีแค่บรรทัดเดียวในไฟล์
const cron = require('node-cron');

const app = express();


// เปิดใช้งาน CORS เพื่อให้ Frontend (พอร์ต 5173) เรียกใช้งานได้
app.use(cors());

// ขยายขีดจำกัดให้รองรับรูปภาพสลิป
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const port = process.env.PORT || 5000;

// 🌟 สร้าง Connection Pool สำหรับ PostgreSQL (ต้องมีแค่ชุดเดียวในไฟล์)
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // จำเป็นสำหรับการเชื่อมต่อฐานข้อมูลบน Cloud เช่น Neon
    }
});

// ---------------------------------------------------------
// 0. ตั้งค่า CORS (จำกัดโดเมนที่อนุญาตให้เข้าถึง API)
// ---------------------------------------------------------
const allowedOrigins = [
  'https://kinnon.live',             // โดเมนหลัก
  'https://useradmin.kinnon.live', 
  'https://apibooking.smartsoft.agency',
  'https://emp.kinnon.live',
   // โดเมนหลัก (มี www)
 'http://localhost:5173',
  'http://localhost:5174'       // สำหรับทดสอบ Frontend (อื่นๆ)
];


// ==========================================
// สร้าง Route ทดสอบ 
// ==========================================

app.get('/api/test', async (req, res) => {
    try {
        const result = await pgPool.query('SELECT NOW()');
        res.json({ message: "เชื่อมต่อฐานข้อมูลสำเร็จ!", time: result.rows[0].now });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "การเชื่อมต่อฐานข้อมูลผิดพลาด" });
    }
});

// ==========================================
// API สำหรับดึงรายชื่อประเทศ  เริ่ม
// ==========================================

app.get('/api/countries', async (req, res) => {
    try {
        const result = await pgPool.query(
            'SELECT id, iso_code, name_th, name_en, currency_code, flag_image_url FROM countries WHERE is_active = TRUE ORDER BY id ASC'
        );
        res.json({ success: true, countries: result.rows });
    } catch (error) {
        console.error('Error fetching countries:', error);
        res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลประเทศได้' });
    }
});

// =========================================================
// 1. API ตรวจสอบว่า Username นี้ถูกใช้ไปหรือยัง (สำหรับตอนพิมพ์อักษร)
// =========================================================
app.get('/api/check-username/:username', async (req, res) => {
    try {
        const { username } = req.params;
        const result = await pgPool.query('SELECT id FROM users WHERE username = $1', [username]);
        
        // ถ้าไม่เจอข้อมูล แสดงว่าว่าง (available = true)
        if (result.rows.length === 0) {
            res.json({ available: true });
        } else {
            res.json({ available: false });
        }
    } catch (error) {
        console.error('Error checking username:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// =========================================================
// 2. API ตรวจสอบผู้แนะนำ (Referrer) และดึงชื่อ-นามสกุลมาแสดง
// =========================================================
app.get('/api/check-referrer/:referrer', async (req, res) => {
    try {
        const { referrer } = req.params;
        
        // ดึงข้อมูลจาก users JOIN กับ user_profiles เพื่อเอา full_name
        const result = await pgPool.query(`
            SELECT u.id, p.full_name 
            FROM users u
            LEFT JOIN user_profiles p ON u.id = p.user_id
            WHERE u.username = $1
        `, [referrer]);

        if (result.rows.length > 0) {
            // ถ้ามี full_name ให้แสดง ถ้าไม่มีให้แสดง username แทน
            const fullName = result.rows[0].full_name || result.rows[0].username;
            res.json({ exists: true, fullName: fullName });
        } else {
            res.json({ exists: false });
        }
    } catch (error) {
        console.error('Error checking referrer:', error);
        res.status(500).json({ exists: false, error: 'Internal Server Error' });
    }
});

// =========================================================
// 3. API สมัครสมาชิก (Register) - บันทึกข้อมูลลงฐานข้อมูลหลายตาราง
// =========================================================
app.post('/api/register', async (req, res) => {
    const { username, password, referrer, country_id } = req.body;
    
    // ดึง connection จาก pool เพื่อทำ Transaction (ต้องสำเร็จทั้งหมดถึงจะบันทึก)
    const client = await pgPool.connect();

    try {
        await client.query('BEGIN'); // เริ่ม Transaction

        // 1. เช็คว่ามี username ซ้ำหรือไม่ (ป้องกันการยิง API ซ้ำซ้อน)
        const checkUser = await client.query('SELECT id FROM users WHERE username = $1', [username]);
        if (checkUser.rows.length > 0) {
            throw new Error('Username นี้มีผู้ใช้งานแล้ว');
        }

        // 2. หา ID ของผู้แนะนำ (ถ้าระบุมา)
        let referrerId = null;
        if (referrer) {
            const refResult = await client.query('SELECT id FROM users WHERE username = $1', [referrer]);
            if (refResult.rows.length > 0) {
                referrerId = refResult.rows[0].id;
            }
        }

        // 3. บันทึกลงตาราง users (level_id และ global_id จะถูกสร้างอัตโนมัติตามโครงสร้าง DB)
        const userInsert = await client.query(`
            INSERT INTO users (username, country_id, referrer_id) 
            VALUES ($1, $2, $3) RETURNING id
        `, [username, country_id || null, referrerId]);
        
        const newUserId = userInsert.rows[0].id;

        // 4. เข้ารหัสผ่าน และบันทึกลงตาราง user_passwords
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        await client.query(`
            INSERT INTO user_passwords (user_id, password_hash, status) 
            VALUES ($1, $2, 'active')
        `, [newUserId, passwordHash]);

        // 5. สร้างโปรไฟล์ว่างๆ ใน user_profiles
        await client.query(`
            INSERT INTO user_profiles (user_id) VALUES ($1)
        `, [newUserId]);

        // 6. กำหนดบทบาทพื้นฐาน (Role) เป็น 'customer' (สมมติว่า customer id คือ 2 จากตาราง roles)
        // หมายเหตุ: หาก id ของ customer ในตาราง roles ของคุณไม่ใช่ 2 ให้ปรับตัวเลขให้ตรง
        await client.query(`
            INSERT INTO user_roles (user_id, role_id) VALUES ($1, 2)
        `, [newUserId]);

        await client.query('COMMIT'); // ยืนยันการบันทึกข้อมูลทั้งหมด
        res.json({ success: true, message: 'สมัครสมาชิกสำเร็จ' });

    } catch (error) {
        await client.query('ROLLBACK'); // ถ้ายกเลิก หรือ Error ให้ย้อนกลับข้อมูลทั้งหมด
        console.error('Register Error:', error);
        res.status(400).json({ success: false, message: error.message || 'ไม่สามารถสมัครสมาชิกได้' });
    } finally {
        client.release(); // คืน connection กลับเข้า pool
    }
});


// ==========================================
// API สำหรับดึงรายชื่อประเทศ  สิ้นสุด
// ==========================================
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});