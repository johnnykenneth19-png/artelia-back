const PDFDocument = require('pdfkit');
const { supabaseAdmin } = require('../config/supabase');
const AppError = require('../utils/AppError');
const config = require('../config');

/**
 * CERTIFICATE OF AUTHENTICITY (spec section 21)
 * ---------------------------------------------------------------------
 * Generates a genuine PDF (pdfkit — pure JS, no native/system
 * dependencies) rather than a placeholder link, uploads it to storage,
 * and stores the public certificate verification page separately from
 * anything that could expose buyer identity: verifyByCertificateNumber()
 * below is what the PUBLIC /verify/:number route calls, and it
 * deliberately selects only artwork/artist/edition fields — never the
 * owner's name, email, or any order/payment detail (spec: "do not
 * expose sensitive buyer information publicly").
 */

async function issue(artworkId, orderId, buyerId = null) {
  const { count } = await supabaseAdmin.from('artwork_certificates').select('id', { count: 'exact', head: true });
  const certificateNumber = `FRZ-ART-${String((count || 0) + 1).padStart(6, '0')}`;

  const { data: certificate, error } = await supabaseAdmin
    .from('artwork_certificates')
    .insert({ artwork_id: artworkId, order_id: orderId, certificate_number: certificateNumber })
    .select('*')
    .single();

  if (error) throw new AppError('Could not issue certificate.', 500, 'CREATE_FAILED');

  await supabaseAdmin.from('provenance_records').insert({
    artwork_id: artworkId,
    order_id: orderId,
    owner_user_id: buyerId,
    event_type: 'sold',
    owner_label: 'Private Collector',
    notes: 'Ownership transferred via ARTELIA marketplace purchase.',
  });

  // Phase 9 (spec section 40, resale marketplace): current_owner_user_id
  // is how resaleService later verifies "does this user actually own
  // this artwork" before letting them list it for resale — without a
  // buyer recorded here, that check has nothing to go on.
  if (buyerId) {
    await supabaseAdmin.from('artworks').update({ current_owner_user_id: buyerId }).eq('id', artworkId);
  }

  // PDF generation failure shouldn't block the sale from finalizing —
  // the certificate row (and its verification page) already exists and
  // is valid without the downloadable file; retry generation separately.
  try {
    const pdfUrl = await generateAndStorePdf(certificate);
    await supabaseAdmin.from('artwork_certificates').update({ pdf_url: pdfUrl }).eq('id', certificate.id);
  } catch (err) {
    console.error('[certificateService] PDF generation failed:', err.message);
  }

  return certificate;
}

async function generateAndStorePdf(certificate) {
  const { data: artwork } = await supabaseAdmin
    .from('artworks')
    .select('title, materials, year_created, width_cm, height_cm, edition_number, edition_size, artwork_type, signature_info, artist_profiles(artist_name)')
    .eq('id', certificate.artwork_id)
    .single();

  const buffer = await renderPdfBuffer(certificate, artwork);

  const path = `certificates/${certificate.certificate_number}.pdf`;
  const { error } = await supabaseAdmin.storage.from(config.storage.artworksBucket).upload(path, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });
  if (error) throw new AppError('Could not store certificate PDF.', 500, 'UPLOAD_FAILED');

  const { data: publicUrlData } = supabaseAdmin.storage.from(config.storage.artworksBucket).getPublicUrl(path);
  return publicUrlData.publicUrl;
}

function renderPdfBuffer(certificate, artwork) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 64 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#a9812f').text('A R T E L I A', { align: 'center', characterSpacing: 4 });
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(22).fillColor('#16140f').text('Certificate of Authenticity', { align: 'center' });
    doc.moveDown(2);

    doc.fontSize(11).fillColor('#7a7364').text('Certificate Number', { continued: false });
    doc.fontSize(14).fillColor('#16140f').text(certificate.certificate_number);
    doc.moveDown(1);

    const row = (label, value) => {
      doc.fontSize(10).fillColor('#7a7364').text(label);
      doc.fontSize(13).fillColor('#16140f').text(value || '—');
      doc.moveDown(0.8);
    };

    row('Artwork Title', artwork?.title);
    row('Artist', artwork?.artist_profiles?.artist_name);
    row('Medium / Materials', artwork?.materials);
    row('Year Created', artwork?.year_created ? String(artwork.year_created) : null);
    row('Dimensions', artwork?.width_cm && artwork?.height_cm ? `${artwork.width_cm} x ${artwork.height_cm} cm` : null);
    row(
      'Edition',
      artwork?.artwork_type === 'limited_edition' && artwork?.edition_size
        ? `${artwork.edition_number} of ${artwork.edition_size}`
        : artwork?.artwork_type === 'original'
        ? 'Original, unique work'
        : 'Open edition print'
    );
    row('Signature', artwork?.signature_info);
    row('Issued', new Date(certificate.issued_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));

    doc.moveDown(2);
    doc.fontSize(9).fillColor('#7a7364').text(
      `Verify this certificate at ${config.frontendUrl}/verify.html?cert=${certificate.certificate_number}`,
      { align: 'center' }
    );

    doc.end();
  });
}

/**
 * Public verification lookup — no auth, no buyer-identifying fields.
 * Powers GET /api/certificates/verify/:number and public/verify.html.
 */
async function verifyByCertificateNumber(certificateNumber) {
  const { data, error } = await supabaseAdmin
    .from('artwork_certificates')
    .select(`
      certificate_number, issued_at, is_valid, pdf_url,
      artworks ( title, materials, year_created, width_cm, height_cm, edition_number, edition_size, artwork_type,
        artist_profiles ( artist_name, slug, is_verified )
      )
    `)
    .eq('certificate_number', certificateNumber)
    .maybeSingle();

  if (error) throw new AppError('Could not verify certificate.', 500, 'QUERY_FAILED');
  if (!data) return { valid: false };

  return {
    valid: data.is_valid,
    certificateNumber: data.certificate_number,
    issuedAt: data.issued_at,
    pdfUrl: data.pdf_url,
    artwork: {
      title: data.artworks?.title,
      materials: data.artworks?.materials,
      yearCreated: data.artworks?.year_created,
      dimensions: data.artworks?.width_cm && data.artworks?.height_cm ? `${data.artworks.width_cm} x ${data.artworks.height_cm} cm` : null,
      edition: data.artworks?.edition_size ? `${data.artworks.edition_number} of ${data.artworks.edition_size}` : null,
      type: data.artworks?.artwork_type,
      artistName: data.artworks?.artist_profiles?.artist_name,
      artistSlug: data.artworks?.artist_profiles?.slug,
      artistVerified: data.artworks?.artist_profiles?.is_verified,
    },
  };
}

/** Admin can invalidate a certificate (e.g. a dispute resolves in a return/refund). */
async function invalidate(certificateNumber, reason) {
  const { data, error } = await supabaseAdmin
    .from('artwork_certificates')
    .update({ is_valid: false })
    .eq('certificate_number', certificateNumber)
    .select('*')
    .maybeSingle();

  if (error) throw new AppError('Could not update certificate.', 500, 'UPDATE_FAILED');
  if (!data) throw new AppError('Certificate not found.', 404, 'NOT_FOUND');
  return data;
}

module.exports = { issue, verifyByCertificateNumber, invalidate };
