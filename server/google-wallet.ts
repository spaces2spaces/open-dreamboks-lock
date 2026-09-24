import jwt from 'jsonwebtoken';

interface GoogleWalletCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

interface BoardingPassData {
  firstName: string;
  lastName: string;
  reservationNumber: string;
  assignedSpace: string;
  arrival: string;
  departure: string;
  accessCode: string;
}

export class GoogleWalletService {
  private issuerId: string;
  private credentials: GoogleWalletCredentials | null = null;

  constructor() {
    this.issuerId = process.env.GOOGLE_WALLET_ISSUER_ID || '';
    
    // Try to load credentials from environment
    const credentialsJson = process.env.GOOGLE_WALLET_CREDENTIALS;
    if (credentialsJson) {
      try {
        this.credentials = JSON.parse(credentialsJson);
      } catch (error) {
        console.error('Failed to parse Google Wallet credentials:', error);
      }
    }
  }

  isConfigured(): boolean {
    return !!(this.issuerId && this.credentials);
  }

  generateAddToWalletLink(data: BoardingPassData): string {
    if (!this.isConfigured()) {
      throw new Error('Google Wallet not configured. Please add GOOGLE_WALLET_ISSUER_ID and GOOGLE_WALLET_CREDENTIALS environment variables.');
    }

    const objectId = `${this.issuerId}.${data.reservationNumber}-${Date.now()}`;
    const classId = `${this.issuerId}.dreamboks-boarding-pass`;

    // Create JWT claims
    const claims = {
      iss: this.credentials!.client_email,
      aud: 'google',
      origins: [],
      typ: 'savetowallet',
      payload: {
        genericObjects: [
          {
            id: objectId,
            classId: classId,
            genericType: 'GENERIC_TYPE_UNSPECIFIED',
            hexBackgroundColor: '#cc352a',
            logo: {
              sourceUri: {
                uri: 'https://dreamboks.com/logo.png'
              }
            },
            cardTitle: {
              defaultValue: {
                language: 'en',
                value: 'DreamBoks Digital Key'
              }
            },
            subheader: {
              defaultValue: {
                language: 'en',
                value: 'Access Code'
              }
            },
            header: {
              defaultValue: {
                language: 'en',
                value: data.accessCode
              }
            },
            barcode: {
              type: 'QR_CODE',
              value: data.accessCode
            },
            textModulesData: [
              {
                id: 'guest',
                header: 'GUEST NAME',
                body: `${data.firstName} ${data.lastName}`
              },
              {
                id: 'reservation',
                header: 'RESERVATION NUMBER',
                body: data.reservationNumber
              },
              {
                id: 'space',
                header: 'SPACE ASSIGNMENT',
                body: data.assignedSpace
              },
              {
                id: 'checkin',
                header: 'CHECK-IN',
                body: new Date(data.arrival).toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })
              },
              {
                id: 'checkout',
                header: 'CHECK-OUT',
                body: new Date(data.departure).toLocaleString('en-GB', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })
              }
            ]
          }
        ]
      }
    };

    // Sign JWT
    const token = jwt.sign(claims, this.credentials!.private_key, {
      algorithm: 'RS256'
    });

    return `https://pay.google.com/gp/v/save/${token}`;
  }
}

export const googleWalletService = new GoogleWalletService();
