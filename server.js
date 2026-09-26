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
  'https://kinnon.smartsoft.agency',             // โดเมนหลัก
  'https://useradmin.smartsoft.agency', 
  'https://apibooking.smartsoft.agency',
  'https://emp.smartsoft.agency',
   // โดเมนหลัก (มี www)
 'http://localhost:5173',
  'http://localhost:5174'       // สำหรับทดสอบ Frontend (อื่นๆ)
];

// สร้าง Route ทดสอบ
app.get('/api/test', async (req, res) => {
    try {
        const result = await pgPool.query('SELECT NOW()');
        res.json({ message: "เชื่อมต่อฐานข้อมูลสำเร็จ!", time: result.rows[0].now });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "การเชื่อมต่อฐานข้อมูลผิดพลาด" });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});