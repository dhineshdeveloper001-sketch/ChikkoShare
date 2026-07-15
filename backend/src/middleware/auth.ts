import { Request, Response, NextFunction } from 'express';
import { validateRoomToken } from '../services/room.service';

export function requireRoomToken(req: Request, res: Response, next: NextFunction): void {
  const { roomId, token } = req.body;
  
  if (!roomId || !token) {
    res.status(401).json({
      success: false,
      message: 'Missing authentication credentials',
      errorCode: 'UNAUTHORIZED',
      timestamp: Date.now()
    });
    return;
  }

  const isValid = validateRoomToken(roomId, token);
  if (!isValid) {
    res.status(403).json({
      success: false,
      message: 'Invalid or expired room token',
      errorCode: 'FORBIDDEN',
      timestamp: Date.now()
    });
    return;
  }

  next();
}
