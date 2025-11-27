// index.js - Cloud Functions HTTP para enviar correos con SendGrid

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const sgMail = require("@sendgrid/mail");

// =====================
// Inicialización Firebase
// =====================
if (!admin.apps.length) {
  admin.initializeApp();
}

// =====================
// Utilidad: inicializar SendGrid
// =====================
function initSendGridOrFail() {
  const sendgridKey = process.env.SENDGRID_API_KEY;

  if (!sendgridKey) {
    console.error(
      "[functions] Falta SENDGRID_API_KEY en las variables de entorno."
    );
    return null;
  }

  sgMail.setApiKey(sendgridKey);
  return sgMail;
}

// =====================
// Helper: respuesta de error
// =====================
function sendError(res, httpCode, message, extra = {}) {
  return res.status(httpCode).json({
    success: false,
    message,
    ...extra,
  });
}

// Helper para normalizar correos (evita duplicados raros)
function normalizeEmail(email) {
  if (!email) return "";
  return String(email).trim().toLowerCase();
}

/* =====================================================================
   1) FLUJO ORIGINAL: NUEVO PROVEEDOR (login.html)
   URL: https://us-central1-<proyecto>.cloudfunctions.net/sendNewProviderEmail
   ===================================================================== */
exports.sendNewProviderEmail = functions.https.onRequest(async (req, res) => {
  // ---- CORS básico ----
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    const mailClient = initSendGridOrFail();
    if (!mailClient) {
      return sendError(
        res,
        500,
        "SendGrid no está configurado en el servidor."
      );
    }

    // ========= Datos que llegan desde el frontend =========
    const {
      providerId,
      providerEmail,
      adminEmails: adminEmailsFromClient,
      zipBase64,
      zipName,
      providerData,
    } = req.body || {};

    if (!providerData) {
      return sendError(res, 400, "Faltan los datos del proveedor.");
    }

    // { linea, razon, direccionFiscal, direccionPatios, frontera, telefonoContacto }
    const {
      linea,
      razon,
      direccionFiscal,
      direccionPatios,
      frontera,
      telefonoContacto,
    } = providerData;

    // ========= Correos de administradores =========
    let adminEmails = Array.isArray(adminEmailsFromClient)
      ? adminEmailsFromClient.map(normalizeEmail).filter(Boolean)
      : [];

    if (!adminEmails.length) {
      const adminsSnapshot = await admin
        .firestore()
        .collection("UsuarioAdmin")
        .where("id", "in", [1, 2])
        .get();

      adminEmails = adminsSnapshot.docs
        .map((doc) => normalizeEmail(doc.data()?.correo))
        .filter(Boolean);
    }

    // 🔹 Eliminar duplicados (muy importante para evitar el error de SendGrid)
    adminEmails = [...new Set(adminEmails)];

    if (!adminEmails.length) {
      console.error(
        "[sendNewProviderEmail] No hay correos de administradores configurados."
      );
      return sendError(
        res,
        500,
        "Los administradores no tienen correo configurado."
      );
    }

    // ========= Cuerpo HTML =========
    const htmlBody = `
      <h2>Nueva solicitud de registro de proveedor</h2>
      <p>Se ha registrado un nuevo proveedor en el sistema de Control de Transportes.</p>
      <h3>Datos del proveedor</h3>
      <ul>
        <li><strong>ID Proveedor:</strong> ${providerId || "-"} </li>
        <li><strong>Línea transportista / Nombre comercial:</strong> ${linea || "-"} </li>
        <li><strong>Razón social:</strong> ${razon || "-"} </li>
        <li><strong>Dirección fiscal:</strong> ${direccionFiscal || "-"} </li>
        <li><strong>Dirección de patios de maniobra:</strong> ${direccionPatios || "-"} </li>
        <li><strong>Frontera por donde cruza:</strong> ${frontera || "-"} </li>
        <li><strong>Contacto (teléfono):</strong> ${telefonoContacto || "-"} </li>
        <li><strong>Contacto (correo electrónico):</strong> ${providerEmail || "-"} </li>
      </ul>
      <p>En el archivo ZIP adjunto se incluye la documentación enviada por el proveedor.</p>
    `;

    // ========= Adjuntar ZIP =========
    const attachments = [];
    if (zipBase64 && zipName) {
      attachments.push({
        content: zipBase64, // base64 sin "data:...;base64,"
        filename: zipName,
        type: "application/zip",
        disposition: "attachment",
      });
    }

    const msg = {
      to: adminEmails, // array de correos únicos
      from: {
        email: "logisticabmm@gmail.com", // remitente verificado en SendGrid
        name: "Control de Transportes BMM",
      },
      subject: "Nueva solicitud de registro de proveedor",
      html: htmlBody,
      attachments,
    };

    try {
      const [sgResponse] = await mailClient.send(msg);
      console.log(
        "[sendNewProviderEmail] Correo (nuevo proveedor) enviado. Status:",
        sgResponse && sgResponse.statusCode
      );
    } catch (sgError) {
      console.error(
        "[sendNewProviderEmail] Error SendGrid (nuevo proveedor):",
        sgError
      );
      if (sgError.response && sgError.response.body) {
        console.error(
          "[sendNewProviderEmail] Detalle SendGrid:",
          JSON.stringify(sgError.response.body)
        );
      }
      throw sgError;
    }

    return res.status(200).json({
      success: true,
      message: "Correo enviado correctamente a los administradores.",
    });
  } catch (error) {
    console.error("[sendNewProviderEmail] Error general:", error);

    if (error.response && error.response.body) {
      console.error(
        "[sendNewProviderEmail] Detalle SendGrid:",
        JSON.stringify(error.response.body)
      );
    }

    return res.status(500).json({
      success: false,
      message: "Ocurrió un error al enviar el correo.",
      error: error.message || String(error),
    });
  }
});

/* =====================================================================
   2) NUEVA FUNCIÓN: ENVÍO DE CREDENCIALES (menu.html)
   URL: https://us-central1-logisticatransportesbmm.cloudfunctions.net/sendAccessCredentials
   ===================================================================== */
exports.sendAccessCredentials = functions.https.onRequest(async (req, res) => {
  // ---- CORS básico ----
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    const mailClient = initSendGridOrFail();
    if (!mailClient) {
      return sendError(
        res,
        500,
        "SendGrid no está configurado en el servidor."
      );
    }

    // 👀 Log completo de lo que llega
    console.log("[sendAccessCredentials] Body recibido:", JSON.stringify(req.body));

    let { to, usuario, contrasena, rol } = req.body || {};

    // Normalizar datos básicos
    const toNorm = normalizeEmail(to);
    const usuarioFinal = (usuario || "").toString().trim();
    const passFinal = (contrasena || "").toString().trim();
    const rolFinal =
      (rol || "").toString().trim() ||
      "Usuario"; // fallback por si algo viene vacío

    // Validaciones mínimas
    if (!toNorm) {
      console.error("[sendAccessCredentials] Falta 'to' (correoDestino).");
      return sendError(res, 400, "Falta el correo del usuario.");
    }
    if (!usuarioFinal || !passFinal) {
      console.error("[sendAccessCredentials] Falta usuario o contraseña.", {
        usuarioFinal,
        passFinalLength: passFinal.length,
      });
      return sendError(res, 400, "Faltan usuario o contraseña.");
    }

    const htmlBody = `
      <h2>Acceso al sistema de Control de Transportes BMM</h2>
      <p>Tu usuario ha sido aprobado. Estas son tus credenciales de acceso:</p>
      <ul>
        <li><strong>Usuario:</strong> ${usuarioFinal}</li>
        <li><strong>Contraseña:</strong> ${passFinal}</li>
        <li><strong>Rol:</strong> ${rolFinal}</li>
      </ul>
      <p>Por favor ingresa al sistema con estas credenciales.</p>
    `;

    const msg = {
      to: toNorm,
      from: {
        email: "logisticabmm@gmail.com",
        name: "Control de Transportes BMM",
      },
      subject: "Credenciales de acceso - Control de Transportes BMM",
      html: htmlBody,
    };

    try {
      const [sgResponse] = await mailClient.send(msg);
      console.log(
        "[sendAccessCredentials] Credenciales enviadas. Status:",
        sgResponse && sgResponse.statusCode
      );
    } catch (sgError) {
      console.error("[sendAccessCredentials] Error SendGrid:", sgError);
      if (sgError.response && sgError.response.body) {
        console.error(
          "[sendAccessCredentials] Detalle SendGrid:",
          JSON.stringify(sgError.response.body)
        );
      }
      throw sgError;
    }

    return res.status(200).json({
      success: true,
      message: "Correo de credenciales enviado correctamente.",
    });
  } catch (error) {
    console.error("[sendAccessCredentials] Error general:", error);
    if (error.response && error.response.body) {
      console.error(
        "[sendAccessCredentials] Detalle SendGrid:",
        JSON.stringify(error.response.body)
      );
    }
    return res.status(500).json({
      success: false,
      message: "Ocurrió un error al enviar el correo.",
      error: error.message || String(error),
    });
  }
});

/* =====================================================================
   3) NUEVA FUNCIÓN: ENVÍO DE CONFIRMACIÓN / PRE-REGISTRO DE CITA
   URL: https://us-central1-<proyecto>.cloudfunctions.net/sendAppointmentNotification
   ===================================================================== */
exports.sendAppointmentNotification = functions.https.onRequest(async (req, res) => {
  // ---- CORS básico ----
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    const mailClient = initSendGridOrFail();
    if (!mailClient) {
      return sendError(
        res,
        500,
        "SendGrid no está configurado en el servidor."
      );
    }

    const {
      providerEmail,
      providerLinea,
      providerRazon,
      providerFrontera,
      citaId,
      cita,
    } = req.body || {};

    if (!providerEmail || !cita || !cita.fecha || !cita.hora) {
      return sendError(res, 400, "Faltan datos para enviar la confirmación de cita.");
    }

    const provEmailNorm = normalizeEmail(providerEmail);

    // =======================
    //  Correos de administradores (id 1 y 2)
    // =======================
    let adminEmails = [];
    try {
      const adminsSnapshot = await admin
        .firestore()
        .collection("UsuarioAdmin")
        .where("id", "in", [1, 2])
        .get();

      adminEmails = adminsSnapshot.docs
        .map((doc) => normalizeEmail(doc.data()?.correo))
        .filter(Boolean);
    } catch (e) {
      console.error("[sendAppointmentNotification] Error obteniendo admins:", e);
    }

    // Unificamos destinatarios (proveedor + admins), eliminando duplicados
    const allRecipients = [...new Set([provEmailNorm, ...adminEmails].filter(Boolean))];

    if (!allRecipients.length) {
      console.error(
        "[sendAppointmentNotification] No hay destinatarios para la cita."
      );
      return sendError(
        res,
        500,
        "No se encontraron correos configurados para notificar la cita."
      );
    }

    const {
      fecha,
      hora,
      horaExtra,
      tipoVisita,
      tipoTransporte,
      destino,
      chofer,
      lineaTransporte,
      placas,
      factura,
      caja,
      sello,
      recolectaCaja,
      cajaDeja,
      cajaRecolecta,
      notas,
      esDomingo,
    } = cita;

    const htmlBody = `
      <h2>Pre-registro de cita de acceso - Control de Transportes BMM</h2>
      <p>Se ha registrado una <strong>nueva cita</strong> con estatus <strong>CitaPendiente</strong>.</p>
      <h3>Datos del proveedor</h3>
      <ul>
        <li><strong>Línea:</strong> ${providerLinea || "-"}</li>
        <li><strong>Razón social:</strong> ${providerRazon || "-"}</li>
        <li><strong>Frontera:</strong> ${providerFrontera || "-"}</li>
        <li><strong>Correo de contacto:</strong> ${provEmailNorm || "-"}</li>
      </ul>
      <h3>Datos de la cita</h3>
      <ul>
        <li><strong>ID Cita:</strong> ${citaId || "-"}</li>
        <li><strong>Fecha:</strong> ${fecha || "-"}</li>
        <li><strong>Hora principal:</strong> ${hora || "-"}</li>
        <li><strong>Hora bloqueada adicional:</strong> ${horaExtra || "-"}</li>
        <li><strong>Tipo de visita:</strong> ${tipoVisita || "-"}</li>
        <li><strong>Tipo de transporte:</strong> ${tipoTransporte || "-"}</li>
        <li><strong>Destino:</strong> ${destino || "-"}</li>
        <li><strong>Nombre del chofer:</strong> ${chofer || "-"}</li>
        <li><strong>Transporte / Línea:</strong> ${lineaTransporte || "-"}</li>
        <li><strong>No. placas:</strong> ${placas || "-"}</li>
        <li><strong>Factura:</strong> ${factura || "-"}</li>
        <li><strong>No. caja:</strong> ${caja || "-"}</li>
        <li><strong>No. sello:</strong> ${sello || "-"}</li>
        <li><strong>¿Recolecta caja?:</strong> ${recolectaCaja || "No"}</li>
        <li><strong>Caja que deja:</strong> ${cajaDeja || "-"}</li>
        <li><strong>Caja que recolecta:</strong> ${cajaRecolecta || "-"}</li>
        <li><strong>Es domingo:</strong> ${esDomingo ? "Sí, requiere aprobación especial" : "No"}</li>
      </ul>
      <h3>Comentarios</h3>
      <p>${(notas || "").replace(/</g, "&lt;") || "-"}</p>
      <p style="margin-top:16px;">
        <em>Importante:</em> Esta notificación corresponde a un <strong>pre-registro</strong>.
        La cita deberá ser revisada y aprobada por el área de logística para considerarse como
        <strong>CitaConfirmada</strong>.
      </p>
    `;

    const msg = {
      to: allRecipients,
      from: {
        email: "logisticabmm@gmail.com",
        name: "Control de Transportes BMM",
      },
      subject: "Pre-registro de cita de acceso - Control de Transportes BMM",
      html: htmlBody,
    };

    try {
      const [sgResponse] = await mailClient.send(msg);
      console.log(
        "[sendAppointmentNotification] Correo de cita enviado. Status:",
        sgResponse && sgResponse.statusCode
      );
    } catch (sgError) {
      console.error("[sendAppointmentNotification] Error SendGrid:", sgError);
      if (sgError.response && sgError.response.body) {
        console.error(
          "[sendAppointmentNotification] Detalle SendGrid:",
          JSON.stringify(sgError.response.body)
        );
      }
      throw sgError;
    }

    return res.status(200).json({
      success: true,
      message: "Notificación de cita enviada correctamente.",
    });
  } catch (error) {
    console.error("[sendAppointmentNotification] Error general:", error);
    if (error.response && error.response.body) {
      console.error(
        "[sendAppointmentNotification] Detalle SendGrid:",
        JSON.stringify(error.response.body)
      );
    }
    return res.status(500).json({
      success: false,
      message: "Ocurrió un error al enviar la notificación de cita.",
      error: error.message || String(error),
    });
  }
});

/* =====================================================================
   4) NUEVA FUNCIÓN: CONFIRMACIÓN DE CITA CON FOLIO Y PDF
   URL: https://us-central1-<proyecto>.cloudfunctions.net/sendCitaConfirmacion
   ===================================================================== */
exports.sendCitaConfirmacion = functions.https.onRequest(async (req, res) => {
  // ---- CORS básico ----
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return sendError(res, 405, "Method Not Allowed");
  }

  try {
    const mailClient = initSendGridOrFail();
    if (!mailClient) {
      return sendError(
        res,
        500,
        "SendGrid no está configurado en el servidor."
      );
    }

    const { to, folio, citaId, datosCita } = req.body || {};

    if (!to || !folio || !datosCita) {
      return sendError(
        res,
        400,
        "Faltan parámetros obligatorios (to, folio, datosCita)."
      );
    }

    const toNorm = normalizeEmail(to);

    const {
      linea,
      placas,
      tipoTransporte,
      tipoVisita,
      fecha,
      hora,
      horaExtra,
      chofer,
      destino,
      factura,
      notas,
      frontera,
      recolectaCaja,
    } = datosCita;

    const subject = `Confirmación de cita de transporte - Folio ${folio}`;

    const textBody = `
Hola,

Tu cita de transporte ha sido CONFIRMADA.

Detalles de la cita:
- Folio: ${folio}
- Fecha: ${fecha || "-"}
- Hora: ${hora || "-"}${horaExtra ? ` (hora extra: ${horaExtra})` : ""}
- Línea transportista: ${linea || "-"}
- Placas: ${placas || "-"}
- Tipo de transporte: ${tipoTransporte || "-"}
- Tipo de visita: ${tipoVisita || "-"}
- Chofer: ${chofer || "-"}
- Destino: ${destino || "-"}
- Factura: ${factura || "-"}
- Frontera: ${frontera || "-"}
- ¿Recolecta caja?: ${recolectaCaja || "-"}
- Comentarios / notas: ${notas || "-"}

Te pedimos revisar el documento adjunto "Indicaciones de ingreso a transportistas"
y tener tu folio a la mano al llegar a caseta, ya que te será solicitado para
permitir el acceso.

Saludos,
Beiersdorf Manufacturing México
Control de Transportes BMM
`.trim();

    const htmlBody = `
      <p>Hola,</p>

      <p>Tu cita de transporte ha sido <strong>CONFIRMADA</strong>.</p>

      <p><strong>Detalles de la cita</strong></p>
      <ul>
        <li><strong>Folio:</strong> ${folio}</li>
        <li><strong>Fecha:</strong> ${fecha || "-"}</li>
        <li><strong>Hora:</strong> ${hora || "-"}${
          horaExtra ? ` (hora extra: ${horaExtra})` : ""
        }</li>
        <li><strong>Línea transportista:</strong> ${linea || "-"}</li>
        <li><strong>Placas:</strong> ${placas || "-"}</li>
        <li><strong>Tipo de transporte:</strong> ${tipoTransporte || "-"}</li>
        <li><strong>Tipo de visita:</strong> ${tipoVisita || "-"}</li>
        <li><strong>Chofer:</strong> ${chofer || "-"}</li>
        <li><strong>Destino:</strong> ${destino || "-"}</li>
        <li><strong>Factura:</strong> ${factura || "-"}</li>
        <li><strong>Frontera:</strong> ${frontera || "-"}</li>
        <li><strong>¿Recolecta caja?:</strong> ${recolectaCaja || "-"}</li>
        <li><strong>Comentarios / notas:</strong> ${
          (notas && notas.replace(/\n/g, "<br>")) || "-"
        }</li>
      </ul>

      <p>
        Te pedimos revisar el documento adjunto
        <strong>"Indicaciones de ingreso a transportistas"</strong> y tener tu folio
        a la mano al llegar a caseta, ya que te será solicitado para permitir el acceso.
      </p>

      <p>Saludos,<br>
      Beiersdorf Manufacturing México<br>
      Control de Transportes BMM</p>
    `;

    // ===== Leer PDF desde functions/docs =====
    const fs = require("fs");
    const path = require("path");

    let attachments = [];
    try {
      const pdfPath = path.join(
        __dirname,
        "docs",
        "Indicaciones de ingreso a transportistas.pdf"
      );
      const pdfBuffer = fs.readFileSync(pdfPath);
      const pdfBase64 = pdfBuffer.toString("base64");

      attachments.push({
        content: pdfBase64,
        filename: "Indicaciones de ingreso a transportistas.pdf",
        type: "application/pdf",
        disposition: "attachment",
      });
    } catch (e) {
      console.error(
        "[sendCitaConfirmacion] No se pudo leer el PDF de indicaciones:",
        e
      );
      // Si falla la lectura del PDF, seguimos enviando el correo sin adjunto
    }

    const msg = {
      to: toNorm,
      from: {
        email: "logisticabmm@gmail.com",
        name: "Control de Transportes BMM",
      },
      subject,
      text: textBody,
      html: htmlBody,
      ...(attachments.length ? { attachments } : {}),
    };

    try {
      const [sgResponse] = await mailClient.send(msg);
      console.log(
        "[sendCitaConfirmacion] Correo de confirmación enviado. Status:",
        sgResponse && sgResponse.statusCode
      );
    } catch (sgError) {
      console.error("[sendCitaConfirmacion] Error SendGrid:", sgError);
      if (sgError.response && sgError.response.body) {
        console.error(
          "[sendCitaConfirmacion] Detalle SendGrid:",
          JSON.stringify(sgError.response.body)
        );
      }
      throw sgError;
    }

    return res.status(200).json({
      success: true,
      message: "Correo de confirmación de cita enviado correctamente.",
    });
  } catch (error) {
    console.error("[sendCitaConfirmacion] Error general:", error);
    if (error.response && error.response.body) {
      console.error(
        "[sendCitaConfirmacion] Detalle SendGrid:",
        JSON.stringify(error.response.body)
      );
    }
    return res.status(500).json({
      success: false,
      message: "Ocurrió un error al enviar la confirmación de cita.",
      error: error.message || String(error),
    });
  }
});