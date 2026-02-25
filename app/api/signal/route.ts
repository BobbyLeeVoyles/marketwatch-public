import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const SIGNAL_FILE = path.join(process.cwd(), 'data', 'signal.json');
const POSITION_FILE = path.join(process.cwd(), 'data', 'position.json');

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    let signal = null;
    let position = null;

    if (fs.existsSync(SIGNAL_FILE)) {
      signal = JSON.parse(fs.readFileSync(SIGNAL_FILE, 'utf-8'));
    }
    if (fs.existsSync(POSITION_FILE)) {
      position = JSON.parse(fs.readFileSync(POSITION_FILE, 'utf-8'));
    }

    return NextResponse.json({ signal, position });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to read engine state' }, { status: 500 });
  }
}
