import pool from './server/db.js';

async function check() {
  try {
    const connection = await pool.getConnection();
    console.log('Successfully connected to the database.');
    
    // Check tables
    const [rows] = await connection.query('SHOW TABLES');
    console.log('Tables in database:', rows.map(r => Object.values(r)[0]));
    
    // Check users
    const [users] = await connection.query('SELECT count(*) as count FROM users');
    console.log('Number of users:', users[0].count);
    
    connection.release();
    process.exit(0);
  } catch (err) {
    console.error('Failed to connect or query:', err.message);
    process.exit(1);
  }
}

check();
