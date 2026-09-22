declare global {
  namespace Express {
    interface Request {
      ctx: {
        requestId: string;
        userId: string;
        wardrobeId: string;
        email: string;
        timezone: string;
      };
      share?: {
        shareLinkId: string;
        wardrobeId: string;
        scope: string;
        garmentIds: string[];
        mode: string;
      };
    }
  }
}

export {};
