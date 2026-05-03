import React, { useState, useEffect, useRef } from 'react';
import Auth from './components/Auth';

const resolveApiUrl = () => {
  const configured = String(import.meta.env.VITE_API_URL || '').trim();
  if (configured) return configured.replace(/\/$/, '');
  return '/api';
};

const API_URL = resolveApiUrl();
const URL_IN_TEXT_RE = /((?:https?:\/\/|www\.)[^\s]+)/gi;
const UPLOADS_BASE_URL = API_URL.replace('/api', '');

const parseApiJson = async (response, fallbackMessage) => {
  const rawText = await response.text();
  let data = null;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      const startsWithHtml = /^\s*</.test(rawText);
      const hint = startsWithHtml
        ? 'Сервер повернув HTML замість JSON. Перезапустіть backend.'
        : 'Некоректний JSON від сервера.';
      throw new Error(hint);
    }
  }
  if (!response.ok || data?.error) {
    throw new Error(data?.error || fallbackMessage);
  }
  return data;
};

const fetchJsonWithTimeout = async (url, options = {}, timeoutMs = 7000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json();
    return { res, data };
  } finally {
    clearTimeout(timeoutId);
  }
};

const repairMojibakeFileName = (value) => {
  const raw = String(value || '').trim();
  if (!raw || !/[ÐÑ]/.test(raw)) return raw;
  try {
    const bytes = new Uint8Array(Array.from(raw).map((char) => char.charCodeAt(0) & 0xff));
    const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
    if (!decoded) return raw;
    return /[\p{Script=Cyrillic}\p{L}\p{N}]/u.test(decoded) ? decoded : raw;
  } catch (_) {
    return raw;
  }
};

const renderTextWithLinks = (text) => {
  const source = String(text || '');
  if (!source) return '';

  const parts = source.split(URL_IN_TEXT_RE);
  return parts.map((part, index) => {
      if (!part) return null;
      if (/^(?:https?:\/\/|www\.)/i.test(part)) {
          const href = part.startsWith('http://') || part.startsWith('https://') ? part : `https://${part}`;
          return (
              <a
                  key={`link-${index}`}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-sky-300 hover:text-sky-200 break-all"
                  onClick={(event) => event.stopPropagation()}
              >
                  {part}
              </a>
          );
      }
      return <React.Fragment key={`text-${index}`}>{part}</React.Fragment>;
  });
};

const getMediaLabel = (msg) => {
  const explicit = repairMojibakeFileName(msg?.mediaName);
  if (explicit) return explicit;
  const mediaPath = String(msg?.mediaPath || '');
  if (!mediaPath) return 'Завантажити файл';
  const base = decodeURIComponent(mediaPath.split('/').pop() || '').trim();
  return repairMojibakeFileName(base) || 'Завантажити файл';
};

function App({ currentUser: initialUser }) {
  const PURCHASE_UNIT_OPTIONS = ['шт', 'м', 'м.п', 'км'];
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const buildUploadUrl = (uploadPath) => {
      const token = String(localStorage.getItem('saas_token') || '').trim();
      const base = `${UPLOADS_BASE_URL}${String(uploadPath || '')}`;
      if (!token) return base;
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}token=${encodeURIComponent(token)}`;
  };
  const [loading, setLoading] = useState(true);
  const [dialogs, setDialogs] = useState([]);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [activeTab, setActiveTab] = useState('messenger');
  const [currentUser, setCurrentUser] = useState(initialUser || localStorage.getItem('saas_username') || null);
  useEffect(() => {
      try {
          const token = localStorage.getItem('saas_token');
          if (!token) return;
          const payload = JSON.parse(atob(token.split('.')[1] || ''));
          const byRole = String(payload?.role || '') === 'admin';
          const byOwnerLogin = String(localStorage.getItem('saas_username') || '').toLowerCase() === 'villomi';
          setIsSystemAdmin(byRole || byOwnerLogin);
      } catch (_) {}
  }, []);
  const [isCompactLayout, setIsCompactLayout] = useState(() => (
      typeof window !== 'undefined' ? window.innerWidth < 1200 : false
  ));
  const [appTheme, setAppTheme] = useState(() => {
      try {
          const saved = localStorage.getItem('tgcrm-app-theme');
          return saved === 'light' ? 'light' : 'dark';
      } catch (_) {
          return 'dark';
      }
  });
  const [isNavCollapsed, setIsNavCollapsed] = useState(() => {
      try {
          return localStorage.getItem('tgcrm-nav-collapsed') === '1';
      } catch (_) {
          return false;
      }
  });
  
  // Додано стани для чату
  const [selectedDialog, setSelectedDialog] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(true);
  const [messageInput, setMessageInput] = useState('');
  const [replyingToMessage, setReplyingToMessage] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [localOutgoingMessagesByChat, setLocalOutgoingMessagesByChat] = useState({});
  const [participants, setParticipants] = useState([]);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [showMentions, setShowMentions] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [messageFiles, setMessageFiles] = useState([]);
  const [chatDropActive, setChatDropActive] = useState(false);
  const fileInputRef = useRef(null);
  const requestFileInputRef = useRef(null);
  const dialogLoadRequestRef = useRef(0);
  const activeDialogIdRef = useRef(null);
  const dialogFetchControllersRef = useRef({
      messages: null,
      note: null,
      participants: null
  });
  const messageElementRefs = useRef(new Map());
  const pendingScrollTargetRef = useRef(null);
  const scrollAttemptTimeoutsRef = useRef([]);
  const highlightTimeoutRef = useRef(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState(null);
  
  const [contacts, setContacts] = useState([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  
  const [folders, setFolders] = useState([]);
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [contactSearchQuery, setContactSearchQuery] = useState('');
  const [bulkTagId, setBulkTagId] = useState('');
  const [bulkMessage, setBulkMessage] = useState('');
  const [bulkDelay, setBulkDelay] = useState(2);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkError, setBulkError] = useState(null);
  const [bulkConfirmTargets, setBulkConfirmTargets] = useState(null);

  const [requestTemplates, setRequestTemplates] = useState([]);
  const [selectedRequestTemplateId, setSelectedRequestTemplateId] = useState(null);
  const [requestFormValues, setRequestFormValues] = useState({});
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [requestConfigSaving, setRequestConfigSaving] = useState(false);
  const [requestSending, setRequestSending] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState(null);
  const [requestChatSearch, setRequestChatSearch] = useState('');
  const [requestTargetParticipants, setRequestTargetParticipants] = useState([]);
  const [loadingRequestParticipants, setLoadingRequestParticipants] = useState(false);
  const [requestAttachment, setRequestAttachment] = useState(null);
  const [requestDropActive, setRequestDropActive] = useState(false);
  const [showRequestPreview, setShowRequestPreview] = useState(() => {
      try {
          const raw = localStorage.getItem('tgcrm-requests-show-preview');
          return raw !== '0';
      } catch (_) {
          return true;
      }
  });
  const [tasks, setTasks] = useState(() => {
      try {
          const raw = localStorage.getItem('tgcrm-tasks-v1');
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
          return [];
      }
  });
  const [taskDraft, setTaskDraft] = useState(() => ({
      title: '',
      description: '',
      dueDate: '',
      planDate: new Date().toISOString().slice(0, 10),
      priority: 'medium',
      status: 'plan',
      chatId: ''
  }));
  const [taskSearch, setTaskSearch] = useState('');
  const [tasksViewTab, setTasksViewTab] = useState('today');
  const [taskFilter, setTaskFilter] = useState('all');
  const [quickTaskTitle, setQuickTaskTitle] = useState('');
  const [bulkTaskText, setBulkTaskText] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [taskDailyNotesByDate, setTaskDailyNotesByDate] = useState(() => {
      try {
          const raw = localStorage.getItem('tgcrm-task-daily-notes-v1');
          const parsed = raw ? JSON.parse(raw) : {};
          return parsed && typeof parsed === 'object' ? parsed : {};
      } catch (_) {
          return {};
      }
  });
  const [taskBotSettings, setTaskBotSettings] = useState({ enabled: false, hasToken: false, chatId: '' });
  const [taskBotTokenDraft, setTaskBotTokenDraft] = useState('');
  const [taskBotChatIdDraft, setTaskBotChatIdDraft] = useState('');
  const [taskReminderSettings, setTaskReminderSettings] = useState(() => {
      try {
          const raw = localStorage.getItem('tgcrm-task-reminder-settings-v1');
          const parsed = raw ? JSON.parse(raw) : {};
          return {
              enabled: !!parsed?.enabled,
              time: typeof parsed?.time === 'string' && parsed.time ? parsed.time : '09:00',
              chatId: typeof parsed?.chatId === 'string' ? parsed.chatId : '',
              lastSentDate: typeof parsed?.lastSentDate === 'string' ? parsed.lastSentDate : ''
          };
      } catch (_) {
          return { enabled: false, time: '09:00', chatId: '', lastSentDate: '' };
      }
  });
  const reminderProcessingRef = useRef(false);
  const dailyDigestProcessingRef = useRef(false);
  const backendTaskSyncLoadedRef = useRef(false);
  const [purchaseImportText, setPurchaseImportText] = useState('');
  const [purchaseImportRows, setPurchaseImportRows] = useState([]);
  const [purchaseImportError, setPurchaseImportError] = useState('');
  const [purchaseManualItem, setPurchaseManualItem] = useState({
      itemName: '',
      equipmentCode: '',
      plant: '',
      unit: '',
      qty: '',
      notes: ''
  });
  const [purchaseTemplateOptions, setPurchaseTemplateOptions] = useState({ managers: [], addresses: [] });
  const [loadingPurchaseOptions, setLoadingPurchaseOptions] = useState(false);
  const [savingPurchaseManagerTemplate, setSavingPurchaseManagerTemplate] = useState(false);
  const [savingPurchaseAddressTemplate, setSavingPurchaseAddressTemplate] = useState(false);
  const [tkTemplateOptions, setTkTemplateOptions] = useState({ managers: [], recipients: [] });
  const [loadingTkOptions, setLoadingTkOptions] = useState(false);
  const [savingTkManagerTemplate, setSavingTkManagerTemplate] = useState(false);
  const [savingTkRecipientTemplate, setSavingTkRecipientTemplate] = useState(false);
  const [logisticsOptions, setLogisticsOptions] = useState({ warehouses: [], recipients: [] });
  const [loadingLogisticsOptions, setLoadingLogisticsOptions] = useState(false);
  const [savingPickupTemplate, setSavingPickupTemplate] = useState(false);
  const [savingDeliveryTemplate, setSavingDeliveryTemplate] = useState(false);
  
  const [tags, setTags] = useState([]);
  const [assignments, setAssignments] = useState([]);

  const [selectedTagForManage, setSelectedTagForManage] = useState(null);

  const [tagModalUserId, setTagModalUserId] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');
  
  const [showAddChatModalForTag, setShowAddChatModalForTag] = useState(null);
  const [tagChatSearchQuery, setTagChatSearchQuery] = useState('');
  
  // New features state
  const [fullscreenImage, setFullscreenImage] = useState(null);
  const [showForwardModal, setShowForwardModal] = useState(null);
  const [forwardSearchQuery, setForwardSearchQuery] = useState('');
  const [messageSelectMode, setMessageSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState([]);
  const [showChatNoteModal, setShowChatNoteModal] = useState(false);
  const [chatNoteText, setChatNoteText] = useState('');
  const [showSaveMessageModal, setShowSaveMessageModal] = useState(null);
  const [messageNoteComment, setMessageNoteComment] = useState('');
  const [savedMessagesList, setSavedMessagesList] = useState([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [allChatNotes, setAllChatNotes] = useState([]);
  const [loadingAllNotes, setLoadingAllNotes] = useState(false);

  // Message Pinning State
  const [showPinnedMessages, setShowPinnedMessages] = useState(false);
  const [pinnedMessagesList, setPinnedMessagesList] = useState([]);
  
  // Create Group State
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [newGroupTitle, setNewGroupTitle] = useState('');
  const [newGroupMembers, setNewGroupMembers] = useState([]);
  const [groupSearchQuery, setGroupSearchQuery] = useState('');

  // Add Member State
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [addMemberSearchQuery, setAddMemberSearchQuery] = useState('');
  const [showManageMembersModal, setShowManageMembersModal] = useState(false);
  const [manageMemberSearchQuery, setManageMemberSearchQuery] = useState('');
  const [showContactProfileModal, setShowContactProfileModal] = useState(false);
  const [selectedContactProfile, setSelectedContactProfile] = useState(null);
  const [showSendContactModal, setShowSendContactModal] = useState(false);
  const [sendContactSearchQuery, setSendContactSearchQuery] = useState('');
  const [showNotificationCenter, setShowNotificationCenter] = useState(false);
  const [showDirectNotificationCenter, setShowDirectNotificationCenter] = useState(false);
  const [mutedNotificationChatIds, setMutedNotificationChatIds] = useState(() => {
      try {
          const raw = localStorage.getItem('tgcrm-muted-notification-chat-ids');
          const parsed = raw ? JSON.parse(raw) : [];
          return Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
      } catch (_) {
          return [];
      }
  });
  const notificationCenterRef = useRef(null);
  const directNotificationCenterRef = useRef(null);
  const notificationPanelRef = useRef(null);
  const directNotificationPanelRef = useRef(null);
  const notificationBellButtonRef = useRef(null);
  const directNotificationBellButtonRef = useRef(null);
  const [notificationPanelPosition, setNotificationPanelPosition] = useState({ top: 72, left: 88 });
  const [directNotificationPanelPosition, setDirectNotificationPanelPosition] = useState({ top: 72, left: 88 });

  const [documentCategories, setDocumentCategories] = useState([]);
  const [documentTemplates, setDocumentTemplates] = useState([]);
  const [loadingDocumentTemplates, setLoadingDocumentTemplates] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [newDocumentCategory, setNewDocumentCategory] = useState('');
  const [canManageDocuments, setCanManageDocuments] = useState(false);
  const [canManageWarehouseOrders, setCanManageWarehouseOrders] = useState(false);
  const [warehouseOrders, setWarehouseOrders] = useState([]);
  const [warehouseOrdersLoading, setWarehouseOrdersLoading] = useState(false);
  const [warehouseOrdersFilter, setWarehouseOrdersFilter] = useState('all');
  const [manualWarehouseOrder, setManualWarehouseOrder] = useState({
      messageText: '',
      projectName: '',
      requesterName: '',
      requestType: 'issuance'
  });
  const [manualWarehouseOrderFile, setManualWarehouseOrderFile] = useState(null);
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [editingWarehouseOrder, setEditingWarehouseOrder] = useState(null);
  const [editingWarehouseOrderFile, setEditingWarehouseOrderFile] = useState(null);
  const [isSystemAdmin, setIsSystemAdmin] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [selectedAdminUserId, setSelectedAdminUserId] = useState('');
  const [selectedAdminPermissions, setSelectedAdminPermissions] = useState({});
  const [loadingAdminUsers, setLoadingAdminUsers] = useState(false);
  const [newDocumentTemplate, setNewDocumentTemplate] = useState({
      categoryId: '',
      title: '',
      description: '',
      fileUrl: ''
  });
  const [editingDocumentTemplateId, setEditingDocumentTemplateId] = useState(null);
  const [editingDocumentTemplate, setEditingDocumentTemplate] = useState({
      categoryId: '',
      title: '',
      description: '',
      fileUrl: ''
  });

  const sortCategoriesByOrder = (items) => (
      [...items].sort((a, b) => {
          const byOrder = Number(a?.sort_order || 0) - Number(b?.sort_order || 0);
          if (byOrder !== 0) return byOrder;
          return Number(a?.id || 0) - Number(b?.id || 0);
      })
  );

  useEffect(() => {
      try {
          localStorage.setItem('tgcrm-nav-collapsed', isNavCollapsed ? '1' : '0');
      } catch (_) {}
  }, [isNavCollapsed]);

  useEffect(() => {
      try {
          localStorage.setItem('tgcrm-requests-show-preview', showRequestPreview ? '1' : '0');
      } catch (_) {}
  }, [showRequestPreview]);

  useEffect(() => {
      if (!isAuthenticated || !backendTaskSyncLoadedRef.current) return;
      const timer = setTimeout(async () => {
          try {
              await fetch(`${API_URL}/tasks`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ tasks, reminderSettings: taskReminderSettings })
              });
          } catch (e) {
              console.error('Не вдалося зберегти задачі на сервері:', e);
          }
      }, 400);
      return () => clearTimeout(timer);
  }, [isAuthenticated, tasks, taskReminderSettings]);

  useEffect(() => {
      try {
          localStorage.setItem('tgcrm-task-daily-notes-v1', JSON.stringify(taskDailyNotesByDate));
      } catch (_) {}
  }, [taskDailyNotesByDate]);

  useEffect(() => {
      if (!isAuthenticated) return;
      const loadTasksFromServer = async () => {
          try {
              const res = await fetch(`${API_URL}/tasks`);
              const data = await parseApiJson(res, 'Не вдалося завантажити задачі');
              if (Array.isArray(data?.tasks)) setTasks(data.tasks);
              if (data?.reminderSettings && typeof data.reminderSettings === 'object') {
                  setTaskReminderSettings((prev) => ({ ...prev, ...data.reminderSettings }));
              }
              backendTaskSyncLoadedRef.current = true;
          } catch (e) {
              backendTaskSyncLoadedRef.current = true;
          }
      };
      loadTasksFromServer();
  }, [isAuthenticated]);

  useEffect(() => {
      const isLight = appTheme === 'light';
      document.body.classList.toggle('theme-light', isLight);
      try {
          localStorage.setItem('tgcrm-app-theme', isLight ? 'light' : 'dark');
      } catch (_) {}
  }, [appTheme]);

  useEffect(() => {
      const handleResize = () => setIsCompactLayout(window.innerWidth < 1200);
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
      const onKeyDown = (event) => {
          const key = String(event.key || '').toLowerCase();
          const isReload = key === 'f5' || ((event.ctrlKey || event.metaKey) && key === 'r');
          if (!isReload) return;
          event.preventDefault();
          handleAppRefresh();
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handlePinMessage = async (msgId, isPinned) => {
      try {
          const res = await fetch(`${API_URL}/chat/${selectedDialog.id}/messages/${msgId}/pin`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pinned: !isPinned })
          });
          const data = await res.json();
          if (data.success && showPinnedMessages) {
              fetchPinnedMessages();
          }
      } catch (e) { console.error(e) }
  };

  const fetchPinnedMessages = async () => {
      try {
          const res = await fetch(`${API_URL}/chat/${selectedDialog.id}/pinned`);
          const data = await res.json();
          if (Array.isArray(data)) setPinnedMessagesList(data);
          setShowPinnedMessages(true);
      } catch(e) { console.error(e) }
  };

  const handleCreateGroup = async () => {
      if (!newGroupTitle || newGroupMembers.length === 0) return;
      try {
          await fetch(`${API_URL}/chat/create_group`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: newGroupTitle, users: newGroupMembers })
          });
          setShowCreateGroupModal(false);
          setNewGroupTitle('');
          setNewGroupMembers([]);
      } catch (e) {
          console.error(e);
      }
  };

  const handleAddMemberToGroup = async (userId) => {
      try {
          await fetch(`${API_URL}/chat/${selectedDialog.id}/add_user`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: String(userId) })
          });
          setShowAddMemberModal(false);
      } catch (e) {
          console.error(e);
      }
  };

  const handleDeleteContact = async (contact) => {
      const name = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.username || 'цей контакт';
      if (!window.confirm(`Видалити ${name} з контактів Telegram?`)) return;

      try {
          const res = await fetch(`${API_URL}/contacts/${contact.id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          setContacts(prev => prev.filter(item => String(item.id) !== String(contact.id)));
      } catch (e) {
          console.error(e);
          alert(e.message || 'Не вдалося видалити контакт');
      }
  };

  const getContactDisplayName = (contact) => {
      if (!contact) return 'Без імені';
      return `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.username || `ID ${contact.id}`;
  };

  const handleSendCrmContact = async (contact) => {
      if (!contact) return;
      if (!selectedDialog) {
          alert('Спочатку відкрийте чат у Месенджері, куди відправити контакт.');
          return;
      }
      if (!contact.phone) {
          alert('У цього контакту немає номера телефону.');
          return;
      }
      try {
          const res = await fetch(`${API_URL}/chat/send-contact`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  peerId: selectedDialog.id,
                  firstName: contact.firstName || '',
                  lastName: contact.lastName || '',
                  phone: `+${String(contact.phone).replace(/^\+/, '')}`,
                  userId: contact.id
              })
          });
          const data = await res.json();
          if (!res.ok || data?.error) throw new Error(data?.error || `HTTP ${res.status}`);

          const dialogId = String(selectedDialog.id);
          const fresh = await fetch(buildMessagesUrl(dialogId, { limit: 80, v: Date.now() }, selectedDialog), { cache: 'no-store' });
          const freshData = await fresh.json();
          if (Array.isArray(freshData)) {
              setMessages(mergeMessagesForDialog(dialogId, freshData));
          }
      } catch (error) {
          console.error(error);
          alert(error.message || 'Не вдалося відправити контакт');
      }
  };

  const openSendContactModal = () => {
      if (!selectedDialog) {
          alert('Спочатку відкрийте чат у Месенджері.');
          return;
      }
      setShowSendContactModal(true);
      if (contacts.length > 0) return;
      setLoadingContacts(true);
      fetch(`${API_URL}/contacts`)
          .then(res => res.json())
          .then(data => {
              if (Array.isArray(data)) setContacts(data);
          })
          .catch(console.error)
          .finally(() => setLoadingContacts(false));
  };

  const handleDeleteCurrentDialog = async () => {
      if (!selectedDialog) return;
      const confirmed = window.confirm(`Видалити діалог "${selectedDialog.name}"? Історія буде очищена в Telegram.`);
      if (!confirmed) return;

      try {
          const res = await fetch(`${API_URL}/chat/${selectedDialog.id}/dialog`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ revoke: true })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          setDialogs(prev => prev.filter(dialog => String(dialog.id) !== String(selectedDialog.id)));
          setSelectedDialog(null);
          setMessages([]);
          setParticipants([]);
      } catch (e) {
          console.error(e);
          alert(e.message || 'Не вдалося видалити діалог');
      }
  };

  const handleDeleteCurrentGroup = async () => {
      if (!selectedDialog) return;
      const confirmed = window.confirm(`Видалити або покинути групу "${selectedDialog.name}"? Якщо у вас немає прав власника, система спробує просто вийти з групи.`);
      if (!confirmed) return;

      try {
          const res = await fetch(`${API_URL}/chat/${selectedDialog.id}/group`, {
              method: 'DELETE'
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          setDialogs(prev => prev.filter(dialog => String(dialog.id) !== String(selectedDialog.id)));
          setSelectedDialog(null);
          setMessages([]);
          setParticipants([]);
          setShowManageMembersModal(false);
          setShowAddMemberModal(false);
      } catch (e) {
          console.error(e);
          alert(e.message || 'Не вдалося видалити групу');
      }
  };

  const handleRemoveMemberFromGroup = async (participant) => {
      if (!selectedDialog) return;
      const name = `${participant.firstName || ''} ${participant.lastName || ''}`.trim() || participant.username || 'цього учасника';
      if (!window.confirm(`Видалити ${name} з групи "${selectedDialog.name}"?`)) return;

      try {
          const res = await fetch(`${API_URL}/chat/${selectedDialog.id}/member/${participant.id}`, {
              method: 'DELETE'
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          setParticipants(prev => prev.filter(item => String(item.id) !== String(participant.id)));
      } catch (e) {
          console.error(e);
          alert(e.message || 'Не вдалося видалити учасника з групи');
      }
  };

  const handleOpenContactProfile = async (contactLike) => {
      if (!contactLike) return;

      let matchedContact = contacts.find(contact => String(contact.id) === String(contactLike.id)) || null;

      if (!matchedContact) {
          try {
              const res = await fetch(`${API_URL}/contacts`);
              const data = await res.json();
              if (Array.isArray(data)) {
                  setContacts(data);
                  matchedContact = data.find(contact => String(contact.id) === String(contactLike.id)) || null;
              }
          } catch (e) {
              console.error(e);
          }
      }

      const normalized = matchedContact || {
          id: String(contactLike.id),
          firstName: contactLike.firstName || '',
          lastName: contactLike.lastName || '',
          username: contactLike.username || '',
          phone: contactLike.phone || '',
          isMutualContact: !!contactLike.isMutualContact
      };

      setSelectedContactProfile(normalized);
      setShowContactProfileModal(true);
  };

  // Folder Manager State
  const [selectedFolderForManage, setSelectedFolderForManage] = useState(null);
  const [showAddChatModalForFolder, setShowAddChatModalForFolder] = useState(false);
  const [folderChatSearchQuery, setFolderChatSearchQuery] = useState('');

  // Settings State
  const [apiConfigured, setApiConfigured] = useState(true);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsApiId, setSettingsApiId] = useState('');
  const [settingsApiHash, setSettingsApiHash] = useState('');
  const [autoDownloadVideos, setAutoDownloadVideos] = useState(() => {
      try {
          return localStorage.getItem('tgcrm-auto-download-video') !== '0';
      } catch (_) {
          return true;
      }
  });
  const [mediaStorageStats, setMediaStorageStats] = useState({ mediaBytes: 0, avatarsBytes: 0, totalBytes: 0 });
  const [loadingMediaStorage, setLoadingMediaStorage] = useState(false);
  const [clearingMediaStorage, setClearingMediaStorage] = useState(false);

  // Local Pins State
  const [localPins, setLocalPins] = useState([]);

  useEffect(() => {
      try {
          localStorage.setItem('tgcrm-auto-download-video', autoDownloadVideos ? '1' : '0');
      } catch (_) {}
  }, [autoDownloadVideos]);
  
  const handleCreateTag = async () => {
      if(!newTagName) return;
      try {
          const res = await fetch(`${API_URL}/tags`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name: newTagName, color: newTagColor }) });
          const newTag = await res.json();
          if(!newTag.error) {
              setTags([...tags, newTag]);
              setNewTagName('');
          } else {
              alert(newTag.error.includes("UNIQUE") ? "Такий тег вже існує!" : newTag.error);
          }
      } catch (e) { console.error(e); alert("Помилка підключення до сервера"); }
  };

  const handleToggleTag = async (userId, tagId, isAssigned) => {
      const url = isAssigned ? `${API_URL}/tags/remove` : `${API_URL}/tags/assign`;
      try {
          await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ chatId: String(userId), tagId }) });
          if (isAssigned) {
              setAssignments(prev => prev.filter(a => !(a.chat_id === String(userId) && a.tag_id === tagId)));
          } else {
              setAssignments(prev => [...prev.filter(a => !(a.chat_id === String(userId) && a.tag_id === tagId)), { chat_id: String(userId), tag_id: tagId }]);
          }
      } catch (e) { console.error(e) }
  };

  const handleUpdateTag = async (id, name, color) => {
      if(!name) return;
      try {
          const res = await fetch(`${API_URL}/tags/${id}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ name, color }) });
          const updated = await res.json();
          if(!updated.error) {
              setTags(prev => prev.map(t => t.id === id ? updated : t));
              setSelectedTagForManage(prev => prev?.id === id ? updated : prev);
          } else {
              alert(updated.error);
          }
      } catch (e) { console.error(e) }
  };

  const handleDeleteTag = async (id) => {
      if (!window.confirm("Дійсно видалити цей тег цілком? Всі клієнти втратять цю відмітку!")) return;
      try {
          await fetch(`${API_URL}/tags/${id}`, { method: 'DELETE' });
          setTags(prev => prev.filter(t => t.id !== id));
          setAssignments(prev => prev.filter(a => a.tag_id !== id));
          if(selectedTagForManage?.id === id) setSelectedTagForManage(null);
      } catch (e) {
          console.error(e);
      }
  };

  const handleTogglePin = async (chatId, isPinned) => {
      const currentFolder = activeFolderId === null ? 'main' : String(activeFolderId);
      
      try {
          // Optimistic UI updates
          if (isPinned) {
              setLocalPins(prev => prev.filter(p => !(p.folder_id === currentFolder && String(p.chat_id) === String(chatId))));
          } else {
              setLocalPins(prev => [...prev, { folder_id: currentFolder, chat_id: String(chatId), pinned_at: Date.now() }]);
          }

          const res = await fetch(`${API_URL}/chat/${chatId}/pin`, {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({ pinned: !isPinned, folderId: currentFolder === 'main' ? null : currentFolder })
          });
          const data = await res.json();
          if (data.error) {
              alert(data.error);
              // Rollback
              fetch(`${API_URL}/chat/local_pins`).then(r=>r.json()).then(d=>Array.isArray(d)&&setLocalPins(d)).catch(console.error);
          }
      } catch (e) {
          console.error(e);
          fetch(`${API_URL}/chat/local_pins`).then(r=>r.json()).then(d=>Array.isArray(d)&&setLocalPins(d)).catch(console.error);
      }
  };

  const handleSaveSettings = async () => {
      if (!settingsApiId || !settingsApiHash) {
          alert("Введіть API ID та API HASH");
          return;
      }
      setLoading(true);
      try {
          console.log("Saving API settings...");
          const res = await fetch(`${API_URL}/settings/telegram`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiId: settingsApiId, apiHash: settingsApiHash })
          });
          const data = await res.json();
          if (data.error) {
              setLoading(false);
              alert(data.error);
          } else {
              console.log("Settings saved, checking auth status...");
              setApiConfigured(true);
              setShowSettingsModal(false);
              
              const statusRes = await fetch(`${API_URL}/auth/status`);
              const statusData = await statusRes.json();
              console.log("Auth status data:", statusData);
              if (statusData?.connected) {
                  setIsAuthenticated(true);
              }
              setLoading(false);
          }
      } catch (e) { 
          console.error("Save settings error:", e);
          setLoading(false);
          alert("Помилка підключення до сервера: " + (e.message || String(e))); 
      }
  };

  const formatBytes = (bytes) => {
      const value = Number(bytes || 0);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB'];
      const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
      const scaled = value / (1024 ** index);
      return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const loadMediaStorageStats = async () => {
      setLoadingMediaStorage(true);
      try {
          const res = await fetch(`${API_URL}/settings/storage`);
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          setMediaStorageStats({
              mediaBytes: Number(data?.mediaBytes || 0),
              avatarsBytes: Number(data?.avatarsBytes || 0),
              totalBytes: Number(data?.totalBytes || 0)
          });
      } catch (error) {
          console.error(error);
      } finally {
          setLoadingMediaStorage(false);
      }
  };

  const handleClearMediaStorage = async () => {
      if (clearingMediaStorage) return;
      if (!window.confirm('Видалити весь локальний кеш медіа й аватарів?')) return;
      setClearingMediaStorage(true);
      try {
          const res = await fetch(`${API_URL}/settings/storage/clear-media`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          await loadMediaStorageStats();
          if (selectedDialog) {
              handleDialogClick(selectedDialog);
          }
      } catch (error) {
          console.error(error);
          alert(`Не вдалося очистити медіа: ${error.message}`);
      } finally {
          setClearingMediaStorage(false);
      }
  };

  const buildMessagesUrl = (dialogId, query = {}, dialogMeta = null) => {
      const url = new URL(`${API_URL}/chat/messages/${dialogId}`, window.location.origin);
      Object.entries(query).forEach(([key, value]) => {
          if (value != null && value !== '') {
              url.searchParams.set(key, String(value));
          }
      });
      if (dialogMeta) {
          const dialogType = dialogMeta.isChannel ? 'channel' : dialogMeta.isGroup ? 'group' : 'user';
          url.searchParams.set('dialogType', dialogType);
      }
      if (!autoDownloadVideos) {
          url.searchParams.set('autoDownloadVideo', '0');
      }
      return url.toString();
  };

  const handleBulkSendInitial = () => {
      setBulkError(null);
      setBulkResult(null);
      
      if (!bulkMessage.trim()) return setBulkError("Введіть текст повідомлення!");
      
      let targets = [];
      if (!bulkTagId) {
          targets = contacts.map(c => String(c.id));
      } else {
          targets = assignments.filter(a => a.tag_id === Number(bulkTagId)).map(a => a.chat_id);
      }
      
      if (targets.length === 0) return setBulkError("Для цього тегу ще не призначено жодного діалогу. Спочатку призначте тег комусь!");
      
      // Замість вікна, що зникає, показуємо підтвердження прямо в інтерфейсі
      setBulkConfirmTargets(targets);
  };

  const executeBulkSend = async () => {
      if (!bulkConfirmTargets || bulkConfirmTargets.length === 0) return;
      
      setBulkLoading(true);
      setBulkResult(null);
      setBulkError(null);
      
      try {
          const res = await fetch(`${API_URL}/bulk/send`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: bulkMessage, targets: bulkConfirmTargets, delaySeconds: bulkDelay })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          setBulkResult(`🚀 Кампанію успішно запущено! Розсилка на ${bulkConfirmTargets.length} клієнтів працює у фоновому режимі.`);
          setBulkMessage('');
      } catch (e) {
          setBulkError("Полка відправки: " + e.message);
      } finally {
          setBulkLoading(false);
          setBulkConfirmTargets(null);
      }
  };

  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const loadOlderMessages = async () => {
      if (loadingMessages || loadingOlderMessages || !hasMoreMessages || !selectedDialog || messages.length === 0) {
          return;
      }

      const oldestMessageId = Number(messages[0]?.id);
      if (!Number.isFinite(oldestMessageId) || oldestMessageId <= 0) {
          setHasMoreMessages(false);
          return;
      }

      const dialogId = String(selectedDialog.id);
      const container = messagesContainerRef.current;
      const previousScrollHeight = container?.scrollHeight || 0;
      const previousScrollTop = container?.scrollTop || 0;
      const pageSize = 120;

      setLoadingOlderMessages(true);
      try {
          const res = await fetch(
              buildMessagesUrl(dialogId, { limit: pageSize, offsetId: oldestMessageId, v: Date.now() }, selectedDialog),
              { cache: 'no-store' }
          );
          const data = await res.json();
          if (!res.ok) {
              throw new Error(data?.error || `HTTP ${res.status}`);
          }
          if (!Array.isArray(data) || data.length === 0) {
              setHasMoreMessages(false);
              return;
          }

          setMessages(prev => mergeMessagesForDialog(dialogId, [...prev, ...data]));
          if (data.length < pageSize) {
              setHasMoreMessages(false);
          }

          requestAnimationFrame(() => {
              if (!messagesContainerRef.current) return;
              const nextScrollHeight = messagesContainerRef.current.scrollHeight;
              messagesContainerRef.current.scrollTop = nextScrollHeight - previousScrollHeight + previousScrollTop;
          });
      } catch (error) {
          console.error('Помилка догрузки старших повідомлень:', error);
      } finally {
          setLoadingOlderMessages(false);
      }
  };
  
  const handleMessagesScroll = (e) => {
      const { scrollTop, scrollHeight, clientHeight } = e.target;
      if (scrollHeight - scrollTop - clientHeight > 150) {
          setShowScrollButton(true);
      } else {
          setShowScrollButton(false);
      }

      if (scrollTop < 140 && !loadingMessages && !loadingOlderMessages && hasMoreMessages) {
          loadOlderMessages();
      }
  };

  const scrollToBottom = () => {
      if (messagesEndRef.current) {
          messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
  };

  const clearScheduledMessageScrolls = () => {
      scrollAttemptTimeoutsRef.current.forEach(timeoutId => clearTimeout(timeoutId));
      scrollAttemptTimeoutsRef.current = [];
  };

  const setMessageElementRef = (messageId, element) => {
      const key = String(messageId);
      if (element) {
          messageElementRefs.current.set(key, element);
      } else {
          messageElementRefs.current.delete(key);
      }
  };

  const scrollToMessageById = (messageId, behavior = 'smooth') => {
      const element = messageElementRefs.current.get(String(messageId));
      if (!element) return false;
      element.scrollIntoView({ behavior, block: 'center' });
      return true;
  };

  const highlightMessageById = (messageId) => {
      const normalized = String(messageId);
      setHighlightedMessageId(normalized);
      if (highlightTimeoutRef.current) {
          clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = setTimeout(() => {
          setHighlightedMessageId((current) => (current === normalized ? null : current));
      }, 2200);
  };

  const jumpToMessageInCurrentDialog = async (messageId) => {
      const normalized = String(messageId);
      pendingScrollTargetRef.current = normalized;

      if (scrollToMessageById(normalized, 'smooth')) {
          highlightMessageById(normalized);
          pendingScrollTargetRef.current = null;
          return;
      }

      if (!selectedDialog) return;

      try {
          const dialogId = String(selectedDialog.id);
          const url = buildMessagesUrl(dialogId, { focusMessageId: normalized }, selectedDialog);
          const res = await fetch(url);
          const data = await res.json();
          if (!Array.isArray(data) || data.length === 0) return;

          setMessages((prev) => mergeMessagesForDialog(dialogId, [...prev, ...data]));

          setTimeout(() => {
              if (scrollToMessageById(normalized, 'smooth')) {
                  highlightMessageById(normalized);
                  pendingScrollTargetRef.current = null;
              }
          }, 80);
      } catch (error) {
          console.error(error);
      }
  };

  const schedulePendingMessageScroll = () => {
      const target = pendingScrollTargetRef.current;
      if (target == null) return;

      clearScheduledMessageScrolls();
      const delays = [0, 120, 320, 700, 1400];

      scrollAttemptTimeoutsRef.current = delays.map((delay, index) => setTimeout(() => {
          const currentTarget = pendingScrollTargetRef.current;
          if (currentTarget == null) return;

          if (currentTarget === 'bottom') {
              if (messagesEndRef.current) {
                  messagesEndRef.current.scrollIntoView({ behavior: index === 0 ? 'auto' : 'smooth' });
              }
          } else {
              scrollToMessageById(currentTarget, index === 0 ? 'auto' : 'smooth');
          }

          if (index === delays.length - 1) {
              pendingScrollTargetRef.current = null;
          }
      }, delay));
  };

  const handleMessageMediaLoad = () => {
      if (pendingScrollTargetRef.current != null) {
          schedulePendingMessageScroll();
      }
  };

  const focusComposer = () => {
      setTimeout(() => {
          const textarea = document.getElementById('message-textarea');
          textarea?.focus();
      }, 0);
  };

  const getCurrentCommentAnchorMessageId = () => {
      if (!messagesContainerRef.current || messages.length === 0) {
          return null;
      }

      const containerRect = messagesContainerRef.current.getBoundingClientRect();
      const visibleEntries = Array.from(messageElementRefs.current.entries())
          .map(([id, element]) => ({ id, element, rect: element.getBoundingClientRect() }))
          .filter(({ rect }) => rect.bottom > containerRect.top && rect.top < containerRect.bottom);

      if (visibleEntries.length === 0) {
          return messages[messages.length - 1]?.id || null;
      }

      const preferredEntry = visibleEntries
          .map(entry => ({
              ...entry,
              score: Math.abs(entry.rect.top - (containerRect.top + 24))
          }))
          .sort((a, b) => a.score - b.score)[0];

      return Number(preferredEntry.id);
  };

  const abortPendingDialogFetches = () => {
      Object.values(dialogFetchControllersRef.current).forEach(controller => controller?.abort());
      dialogFetchControllersRef.current = {
          messages: null,
          note: null,
          participants: null
      };
  };

  const initialScrollDone = useRef(false);

  useEffect(() => {
      activeDialogIdRef.current = selectedDialog ? String(selectedDialog.id) : null;
      initialScrollDone.current = false;
      clearScheduledMessageScrolls();
  }, [selectedDialog?.id]);

  useEffect(() => {
      return () => {
          abortPendingDialogFetches();
          clearScheduledMessageScrolls();
          if (highlightTimeoutRef.current) {
              clearTimeout(highlightTimeoutRef.current);
          }
      };
  }, []);

  // Auto-scroll to bottom of messages
  useEffect(() => {
      if (!messagesContainerRef.current || !messagesEndRef.current || messages.length === 0) return;

      if (pendingScrollTargetRef.current != null) {
          schedulePendingMessageScroll();
          initialScrollDone.current = true;
          return;
      }
      
      if (!initialScrollDone.current) {
          // Force immediate scroll for first load
          setTimeout(() => {
              if (messagesEndRef.current) {
                  messagesEndRef.current.scrollIntoView({ behavior: 'auto' });
                  initialScrollDone.current = true;
              }
          }, 100);
          return;
      }

      const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 300;
      
      if (isNearBottom) {
          messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
      }
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const { data: settingsData } = await fetchJsonWithTimeout(`${API_URL}/settings/telegram`, {}, 7000);
        if (cancelled) return;
        setApiConfigured(!!settingsData?.configured);

        if (!settingsData?.configured) {
          setLoading(false);
          return;
        }

        const { data: statusData } = await fetchJsonWithTimeout(`${API_URL}/auth/status`, {}, 7000);
        if (cancelled) return;
        if (statusData?.connected) {
          setIsAuthenticated(true);
        }
      } catch (err) {
        console.error("Backend offline or Error:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    boot();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let intervalMessages;
    if (isAuthenticated && selectedDialog) {
        const dialogId = String(selectedDialog.id);
        const pollMessages = () => {
            fetch(buildMessagesUrl(dialogId, { limit: 80, v: Date.now() }, selectedDialog), { cache: 'no-store' })
              .then(res => res.json())
              .then(data => {
                  if (activeDialogIdRef.current === dialogId && Array.isArray(data)) {
                      setMessages(prev => mergeMessagesForDialog(dialogId, [...prev, ...data]));
                  }
              })
              .catch(console.error);
        };
        intervalMessages = setInterval(pollMessages, 10000);
    }
    return () => clearInterval(intervalMessages);
  }, [isAuthenticated, selectedDialog?.id, localOutgoingMessagesByChat]);

  useEffect(() => {
      let intervalDialogs;
      if (isAuthenticated) {
          const fetchInitial = () => {
              fetch(`${API_URL}/chat/local_pins?v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => { if (Array.isArray(data)) setLocalPins(data); })
                .catch(console.error);

              fetch(`${API_URL}/chat/dialogs?v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) setDialogs(data.sort((a,b) => b.date - a.date));
                })
                .catch(console.error);
                
              fetch(`${API_URL}/chat/folders?v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) setFolders(data);
                })
                .catch(console.error);

              fetch(`${API_URL}/tags?v=${Date.now()}`, { cache: 'no-store' }).then(r=>r.json()).then(data => Array.isArray(data) && setTags(data)).catch(()=>{});
              fetch(`${API_URL}/tags/assignments?v=${Date.now()}`, { cache: 'no-store' }).then(r=>r.json()).then(data => Array.isArray(data) && setAssignments(data)).catch(()=>{});
          };

          const pollUpdates = () => {
              fetch(`${API_URL}/chat/local_pins?v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => { if (Array.isArray(data)) setLocalPins(data); })
                .catch(console.error);

              // Only pull top 50 to prevent freezing backend every 10 seconds
              fetch(`${API_URL}/chat/dialogs?limit=50&v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => {
                    if (Array.isArray(data)) {
                        setDialogs(prev => {
                            const map = new Map(prev.map(d => [d.id, d]));
                            data.forEach(d => map.set(d.id, d));
                            return Array.from(map.values()).sort((a, b) => b.date - a.date);
                        });
                    }
                })
                .catch(console.error);
              // Also update folders quietly
              fetch(`${API_URL}/chat/folders?v=${Date.now()}`, { cache: 'no-store' })
                .then(res => res.json())
                .then(data => { if (Array.isArray(data)) setFolders(data); }).catch(console.error);
          };

          setLoadingDialogs(true);
          fetchInitial();
          setLoadingDialogs(false);

          // Force-polling for dialogs (sidebar updates)
          intervalDialogs = setInterval(pollUpdates, 10000);
      }
      return () => clearInterval(intervalDialogs);
  }, [isAuthenticated]);

  useEffect(() => {
      if (!isAuthenticated) return;
      fetch(`${API_URL}/orders/permissions`)
          .then((res) => res.json())
          .then((data) => setCanManageWarehouseOrders(Boolean(data?.canManage)))
          .catch(() => {});
  }, [isAuthenticated]);

  useEffect(() => {
      if (activeTab === 'crm' || activeTab === 'bulk' || activeTab === 'tagsManager' || activeTab === 'requests' || activeTab === 'tasks' || activeTab === 'documentTemplates') {
          if (contacts.length === 0) {
              setLoadingContacts(true);
              fetch(`${API_URL}/contacts`)
                  .then(res => res.json())
                  .then(data => {
                      if (Array.isArray(data)) setContacts(data);
                  })
                  .catch(console.error)
                  .finally(() => setLoadingContacts(false));
          }
      }
      if (activeTab === 'savedNotes') {
          setLoadingSaved(true);
          fetch(`${API_URL}/notes/saved`)
              .then(res => res.json())
              .then(data => setSavedMessagesList(Array.isArray(data) ? data : []))
              .catch(console.error)
              .finally(() => setLoadingSaved(false));
      }
      if (activeTab === 'comments') {
          setLoadingAllNotes(true);
          fetch(`${API_URL}/notes/chat_notes`)
              .then(res => res.json())
              .then(data => setAllChatNotes(Array.isArray(data) ? data : []))
              .catch(console.error)
              .finally(() => setLoadingAllNotes(false));
      }
      if (activeTab === 'requests') {
          loadRequestTemplates();
      }
      if (activeTab === 'documentTemplates') {
          loadDocumentTemplates();
      }
  }, [activeTab]);

  const addFilesToComposer = (filesLike) => {
      const incoming = Array.from(filesLike || []).filter(Boolean);
      if (incoming.length === 0) return;
      setMessageFiles((prev) => {
          const existingKeys = new Set(prev.map((file) => `${file.name}:${file.size}:${file.lastModified}`));
          const next = [...prev];
          for (const file of incoming) {
              const key = `${file.name}:${file.size}:${file.lastModified}`;
              if (existingKeys.has(key)) continue;
              if (next.length >= 5) break;
              next.push(file);
              existingKeys.add(key);
          }
          return next;
      });
  };

  const clearComposerFiles = () => {
      setMessageFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeComposerFile = (indexToRemove) => {
      setMessageFiles((prev) => {
          const next = prev.filter((_, index) => index !== indexToRemove);
          if (fileInputRef.current && next.length === 0) {
              fileInputRef.current.value = "";
          }
          return next;
      });
  };

  const handleOpenMediaFolder = async (mediaPath) => {
      if (!mediaPath || String(mediaPath).startsWith('blob:')) return;
      try {
          const res = await fetch(`${API_URL}/chat/open-media-folder`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ mediaPath })
          });
          const data = await res.json();
          if (data.error) {
              throw new Error(data.error);
          }
      } catch (error) {
          console.error(error);
          alert(error.message || 'Не вдалося відкрити папку з файлом');
      }
  };

  const handleDownloadMessageMedia = async (chatId, messageId) => {
      try {
          const res = await fetch(`${API_URL}/chat/messages/${chatId}/${messageId}/download-media`, {
              method: 'POST'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
          setMessages((prev) => prev.map((msg) => (
              String(msg.id) === String(messageId)
                  ? { ...msg, mediaPath: data.mediaPath || msg.mediaPath, mediaName: data.mediaName || msg.mediaName || null }
                  : msg
          )));
      } catch (error) {
          console.error(error);
          alert(`Не вдалося завантажити медіа: ${error.message}`);
      }
  };

  const handleRetryFailedMessage = async (failedMsg) => {
      if (!failedMsg || !selectedDialog) return;
      const targetId = String(selectedDialog.id);
      const msgChatId = String(failedMsg.retryPeerId || targetId);
      if (msgChatId !== targetId) {
          alert('Повторне відправлення доступне лише в поточному чаті.');
          return;
      }

      const retryFile = failedMsg.retryFile || null;
      const retryText = String(failedMsg.retryText ?? failedMsg.text ?? '');
      const retryReplyTo = failedMsg.retryReplyTo || failedMsg.replyTo || null;

      const sendingMessage = { ...failedMsg, sendStatus: 'sending', sendError: null };
      setMessages((prev) => prev.map((m) => (String(m.id) === String(failedMsg.id) ? sendingMessage : m)));
      setLocalOutgoingMessagesByChat((prev) => ({
          ...prev,
          [targetId]: (prev[targetId] || []).map((m) => (String(m.id) === String(failedMsg.id) ? sendingMessage : m))
      }));

      try {
          const formData = new FormData();
          formData.append('peerId', selectedDialog.id);
          formData.append('message', retryText || '');
          if (retryReplyTo) formData.append('replyTo', retryReplyTo);
          if (retryFile) formData.append('file', retryFile);

          const res = await fetch(`${API_URL}/chat/send`, {
              method: 'POST',
              body: formData
          });
          const newMsg = await res.json();
          if (!res.ok || newMsg.error) throw new Error(newMsg?.error || `HTTP ${res.status}`);

          setMessages((prev) => prev.map((m) => (String(m.id) === String(failedMsg.id) ? newMsg : m)));
          setLocalOutgoingMessagesByChat((prev) => ({
              ...prev,
              [targetId]: (prev[targetId] || []).filter((m) => String(m.id) !== String(failedMsg.id))
          }));
      } catch (error) {
          const failedAgain = { ...sendingMessage, sendStatus: 'failed', sendError: error.message || 'Помилка мережі або сервер недоступний' };
          setMessages((prev) => prev.map((m) => (String(m.id) === String(failedMsg.id) ? failedAgain : m)));
          setLocalOutgoingMessagesByChat((prev) => ({
              ...prev,
              [targetId]: (prev[targetId] || []).map((m) => (String(m.id) === String(failedMsg.id) ? failedAgain : m))
          }));
      }
  };

  const handleSendMessage = async () => {
      if ((!messageInput.trim() && messageFiles.length === 0) || !selectedDialog) return;
      
      const msgToSend = messageInput;
      const filesToSend = [...messageFiles];
      const isEditing = !!editingMessage;
      const isReplyingToId = replyingToMessage ? replyingToMessage.id : null;

      if (isEditing) {
          try {
              const res = await fetch(`${API_URL}/chat/messages`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                      peerId: selectedDialog.id,
                      messageId: editingMessage.id,
                      text: msgToSend
                  })
              });
              const data = await res.json();
              if (data.success) {
                  setMessages(prev => prev.map(m => m.id === editingMessage.id ? { ...m, text: msgToSend } : m));
                  setMessageInput('');
                  setEditingMessage(null);
              } else {
                  console.error('Edit error:', data.error);
              }
          } catch (e) {
              console.error('Edit error:', e);
          }
          return;
      }

      setMessageInput('');
      clearComposerFiles();
      setReplyingToMessage(null);
      setEditingMessage(null);

      const buildTempMessage = (text, file, index = 0) => ({
          id: Date.now() + index,
          text: text || '',
          date: Math.floor(Date.now() / 1000),
          out: true,
          isRead: false,
          sendStatus: 'sending',
          sendError: null,
          senderId: 'me',
          senderAvatarPath: null,
          replyTo: isReplyingToId,
          mediaPath: file ? URL.createObjectURL(file) : null,
          retryText: text || '',
          retryFile: file || null,
          retryReplyTo: isReplyingToId,
          retryPeerId: selectedDialog.id
      });

      const sendSinglePayload = async ({ text, file, tempMsg, includeReply }) => {
          try {
              const formData = new FormData();
              formData.append('peerId', selectedDialog.id);
              formData.append('message', text || '');
              if (includeReply && isReplyingToId) formData.append('replyTo', isReplyingToId);
              if (file) formData.append('file', file);

              const res = await fetch(`${API_URL}/chat/send`, {
                  method: 'POST',
                  body: formData
              });
              const newMsg = await res.json();
              if (newMsg.error) throw new Error(newMsg.error);

              setMessages(prev => prev.map(m => m.id === tempMsg.id ? newMsg : m));
              setLocalOutgoingMessagesByChat(prev => {
                  const chatId = String(selectedDialog.id);
                  return {
                      ...prev,
                      [chatId]: (prev[chatId] || []).filter(message => message.id !== tempMsg.id)
                  };
              });
          } catch (error) {
              console.error('Send error:', error);
              const failedMessage = { ...tempMsg, sendStatus: 'failed', sendError: error.message || 'Помилка мережі або сервер недоступний' };
              setMessages(prev => prev.map(m => m.id === tempMsg.id ? failedMessage : m));
              setLocalOutgoingMessagesByChat(prev => {
                  const chatId = String(selectedDialog.id);
                  return {
                      ...prev,
                      [chatId]: (prev[chatId] || []).map(message => message.id === tempMsg.id ? failedMessage : message)
                  };
              });
          }
      };

      if (filesToSend.length === 0) {
          const tempMsg = buildTempMessage(msgToSend, null);
          setMessages(prev => [...prev, tempMsg]);
          setLocalOutgoingMessagesByChat(prev => {
              const chatId = String(selectedDialog.id);
              return { ...prev, [chatId]: [...(prev[chatId] || []), tempMsg] };
          });
          await sendSinglePayload({ text: msgToSend, file: null, tempMsg, includeReply: true });
          return;
      }

      const tempMessages = filesToSend.map((file, index) => {
          const textForFile = index === 0 ? msgToSend : '';
          return buildTempMessage(textForFile, file, index);
      });

      setMessages(prev => [...prev, ...tempMessages]);
      setLocalOutgoingMessagesByChat(prev => {
          const chatId = String(selectedDialog.id);
          return { ...prev, [chatId]: [...(prev[chatId] || []), ...tempMessages] };
      });

      for (let index = 0; index < filesToSend.length; index += 1) {
          const file = filesToSend[index];
          const tempMsg = tempMessages[index];
          const textForFile = index === 0 ? msgToSend : '';
          await sendSinglePayload({
              text: textForFile,
              file,
              tempMsg,
              includeReply: index === 0
          });
      }
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    const pos = e.target.selectionStart;
    setMessageInput(val);

    const lastAt = val.lastIndexOf('@', pos - 1);
    if (lastAt !== -1) {
      const query = val.substring(lastAt + 1, pos);
      if (!query.includes(' ') && !query.includes('\n')) {
        setMentionQuery(query);
        setShowMentions(true);
        setActiveMentionIndex(0);
      } else {
        setShowMentions(false);
      }
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (user) => {
    const val = messageInput;
    const textarea = document.getElementById('message-textarea');
    const pos = textarea ? textarea.selectionStart : val.length;
    const lastAt = val.lastIndexOf('@', pos - 1);
    const mentionText = user.username || user.firstName;
    const newVal = val.substring(0, lastAt) + '@' + mentionText + ' ' + val.substring(pos);
    setMessageInput(newVal);
    setShowMentions(false);
    setTimeout(() => {
        if (textarea) {
            textarea.focus();
            const newPos = lastAt + mentionText.length + 2;
            textarea.setSelectionRange(newPos, newPos);
        }
    }, 0);
  };

  const filteredParticipants = participants.filter(p => 
    (p.username || '').toLowerCase().includes((mentionQuery || '').toLowerCase()) ||
    (p.firstName || '').toLowerCase().includes((mentionQuery || '').toLowerCase()) ||
    (p.lastName || '').toLowerCase().includes((mentionQuery || '').toLowerCase())
  ).slice(0, 8);

  const getRequestParticipantLabel = (participant) => {
      const fullName = `${participant?.firstName || ''} ${participant?.lastName || ''}`.trim();
      if (fullName) return fullName;
      if (participant?.username) return `@${participant.username}`;
      return `ID ${participant?.id || '—'}`;
  };

  const getRequestParticipantMentionValue = (participant) => {
      if (participant?.username) return `@${participant.username}`;
      return getRequestParticipantLabel(participant);
  };

  const messagesById = React.useMemo(
      () => new Map(messages.map(message => [String(message.id), message])),
      [messages]
  );

  const mergeMessagesForDialog = (chatId, serverMessages) => {
      const localMessages = localOutgoingMessagesByChat[String(chatId)] || [];
      const dedupedServerMap = new Map();
      for (const message of serverMessages) {
          const idKey = String(message?.id);
          if (!idKey || idKey === 'undefined') continue;
          dedupedServerMap.set(idKey, message);
      }
      const dedupedServer = Array.from(dedupedServerMap.values());

      if (localMessages.length === 0) {
          return dedupedServer.sort((a, b) => (a.date || 0) - (b.date || 0));
      }

      const existingIds = new Set(dedupedServer.map(message => String(message.id)));
      return [...dedupedServer, ...localMessages.filter(message => !existingIds.has(String(message.id)))]
          .sort((a, b) => (a.date || 0) - (b.date || 0));
  };

  const hasChatNote = chatNoteText.trim().length > 0;
  const chatNotePreview = hasChatNote
      ? chatNoteText.trim().replace(/\s+/g, ' ').slice(0, 110)
      : '';

  const normalizeChatRecord = (chat) => {
      if (!chat) return null;

      const displayName = chat.name || `${chat.firstName || ''} ${chat.lastName || ''}`.trim() || chat.username || 'Невідомий чат';
      return {
          ...chat,
          id: String(chat.id),
          name: displayName,
          unreadCount: chat.unreadCount || 0,
          unreadMentionsCount: chat.unreadMentionsCount || 0,
          lastMessage: chat.lastMessage || '',
          isGroup: !!chat.isGroup,
          isChannel: !!chat.isChannel,
          isUser: chat.isUser ?? (!chat.isGroup && !chat.isChannel),
          isIgnored: !!chat.isIgnored,
          avatarPath: chat.avatarPath || null
      };
  };

  const findChatById = (chatId) => normalizeChatRecord(
      dialogs.find(dialog => String(dialog.id) === String(chatId)) ||
      contacts.find(contact => String(contact.id) === String(chatId))
  );

  const openChatById = async (chatId, options = {}) => {
      const normalizedChatId = String(chatId);
      let chat = findChatById(normalizedChatId);

      if (!chat) {
          try {
              const res = await fetch(`${API_URL}/chat/dialogs?limit=2000&v=${Date.now()}`, { cache: 'no-store' });
              const data = await res.json();
              if (Array.isArray(data)) {
                  setDialogs(data.sort((a, b) => (b.date || 0) - (a.date || 0)));
                  chat = normalizeChatRecord(data.find(dialog => String(dialog.id) === normalizedChatId));
              }
          } catch (error) {
              console.error('openChatById refresh dialogs error:', error);
          }
      }

      if (!chat) {
          alert('Чат не знайдено або недоступний у вашому Telegram.');
          return false;
      }

      setActiveTab('messenger');
      try {
          handleDialogClick(chat, options);
          return true;
      } catch (error) {
          console.error('openChatById error:', error);
          alert('Не вдалося відкрити чат. Спробуйте ще раз.');
          return false;
      }
  };

  const handleStartReply = (message) => {
      setEditingMessage(null);
      setReplyingToMessage(message);
      focusComposer();
  };

  const handleStartEdit = (message) => {
      setReplyingToMessage(null);
      setEditingMessage(message);
      setMessageInput(message.text || '');
      focusComposer();
  };

  const clearComposerMode = () => {
      setReplyingToMessage(null);
      setEditingMessage(null);
  };

  const selectedRequestTemplate = React.useMemo(
      () => requestTemplates.find(template => template.id === selectedRequestTemplateId) || null,
      [requestTemplates, selectedRequestTemplateId]
  );

  useEffect(() => {
      const isMentionsTemplate =
          selectedRequestTemplate?.code === 'warehouse_issue_request' ||
          selectedRequestTemplate?.code === 'logistics_request' ||
          selectedRequestTemplate?.code === 'purchase_request' ||
          selectedRequestTemplate?.code === 'tk_delivery_request';
      if (!selectedRequestTemplate?.target_chat_id || !isMentionsTemplate) {
          setRequestTargetParticipants([]);
          return;
      }

      let cancelled = false;
      setLoadingRequestParticipants(true);

      fetch(`${API_URL}/chat/${selectedRequestTemplate.target_chat_id}/participants`)
          .then(res => res.json())
          .then(data => {
              if (!cancelled) {
                  setRequestTargetParticipants(Array.isArray(data) ? data : []);
              }
          })
          .catch(error => {
              if (!cancelled) {
                  console.error(error);
                  setRequestTargetParticipants([]);
              }
          })
          .finally(() => {
              if (!cancelled) {
                  setLoadingRequestParticipants(false);
              }
          });

      return () => {
          cancelled = true;
      };
  }, [selectedRequestTemplate]);

  const loadLogisticsOptions = async () => {
      setLoadingLogisticsOptions(true);
      try {
          const res = await fetch(`${API_URL}/requests/logistics/options?v=${Date.now()}`, { cache: 'no-store' });
          const data = await res.json();
          setLogisticsOptions({
              warehouses: Array.isArray(data?.warehouses) ? data.warehouses : [],
              recipients: Array.isArray(data?.recipients) ? data.recipients : []
          });
      } catch (error) {
          console.error(error);
          setLogisticsOptions({ warehouses: [], recipients: [] });
      } finally {
          setLoadingLogisticsOptions(false);
      }
  };

  const loadPurchaseTemplateOptions = async () => {
      setLoadingPurchaseOptions(true);
      try {
          const res = await fetch(`${API_URL}/requests/purchase/options?v=${Date.now()}`, { cache: 'no-store' });
          const data = await res.json();
          setPurchaseTemplateOptions({
              managers: Array.isArray(data?.managers) ? data.managers : [],
              addresses: Array.isArray(data?.addresses) ? data.addresses : []
          });
      } catch (error) {
          console.error(error);
          setPurchaseTemplateOptions({ managers: [], addresses: [] });
      } finally {
          setLoadingPurchaseOptions(false);
      }
  };

  const loadTkTemplateOptions = async () => {
      setLoadingTkOptions(true);
      try {
          const res = await fetch(`${API_URL}/requests/tk/options?v=${Date.now()}`, { cache: 'no-store' });
          const data = await res.json();
          setTkTemplateOptions({
              managers: Array.isArray(data?.managers) ? data.managers : [],
              recipients: Array.isArray(data?.recipients) ? data.recipients : []
          });
      } catch (error) {
          console.error(error);
          setTkTemplateOptions({ managers: [], recipients: [] });
      } finally {
          setLoadingTkOptions(false);
      }
  };

  useEffect(() => {
      if (selectedRequestTemplate?.code === 'logistics_request') {
          loadLogisticsOptions();
      }
      if (selectedRequestTemplate?.code === 'purchase_request') {
          loadPurchaseTemplateOptions();
      }
      if (selectedRequestTemplate?.code === 'tk_delivery_request') {
          loadTkTemplateOptions();
      }
  }, [selectedRequestTemplate?.id, selectedRequestTemplate?.code]);

  const filteredRequestDialogs = React.useMemo(() => {
      const query = requestChatSearch.trim().toLowerCase();

      return dialogs
          .filter(dialog => {
              if (!query) return true;
              return (dialog.name || '').toLowerCase().includes(query);
          });
  }, [dialogs, requestChatSearch]);

  const getRequestFieldDefaultValue = (field) => {
      if (field.type === 'multi_contact_mentions') return [];
      if (field.defaultValue != null) return field.defaultValue;
      return '';
  };

  const getTodayDateValue = () => new Date().toISOString().slice(0, 10);
  const getTomorrowDateValue = () => {
      const date = new Date();
      date.setDate(date.getDate() + 1);
      return date.toISOString().slice(0, 10);
  };
  const getCurrentTimeValue = () => {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
  };

  const sendTelegramReminderMessage = async (messageText) => {
      const response = await fetch(`${API_URL}/settings/bot/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(messageText || '') })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
          throw new Error(data?.error || 'Не вдалося надіслати нагадування');
      }
      return data;
  };

  const buildTaskReminderText = (task) => {
      const lines = [
          'Нагадування по задачі',
          `Задача: ${task.title || 'Без назви'}`
      ];
      if (task.description) lines.push(`Опис: ${task.description}`);
      if (task.dueDate) lines.push(`Дедлайн: ${task.dueDate}`);
      return lines.join('\n');
  };

  const buildDailyDigestText = (dailyTasks, dayValue) => {
      const header = [`Щоденний дайджест задач (${dayValue})`, ''];
      if (!dailyTasks.length) {
          return [...header, 'На сьогодні задач немає.'].join('\n');
      }
      const rows = dailyTasks.map((task, index) => {
          const duePart = task.dueDate ? ` | дедлайн: ${task.dueDate}` : '';
          const statusPart = task.status === 'done' ? 'готово' : task.status === 'in_progress' ? 'в роботі' : 'план';
          return `${index + 1}. ${task.title || 'Без назви'} (${statusPart}${duePart})`;
      });
      return [...header, ...rows].join('\n');
  };

  const resolveTaskChatName = (chatId) => {
      if (!chatId) return '';
      const matchedDialog = dialogs.find((dialog) => String(dialog.id) === String(chatId));
      if (matchedDialog?.name) return matchedDialog.name;
      const matchedContact = contacts.find((contact) => String(contact.id) === String(chatId));
      if (matchedContact) {
          const fullName = `${matchedContact.firstName || ''} ${matchedContact.lastName || ''}`.trim();
          return fullName || matchedContact.username || `ID ${matchedContact.id}`;
      }
      return `ID ${chatId}`;
  };

  const upsertTask = (taskId, updater) => {
      setTasks((prev) => prev.map((task) => (task.id === taskId ? updater(task) : task)));
  };

  const handleCreateTask = () => {
      const title = String(taskDraft.title || '').trim();
      if (!title) return;
      const today = getTodayDateValue();
      const createdTask = {
          id: `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          title,
          description: String(taskDraft.description || '').trim(),
          dueDate: taskDraft.dueDate || '',
          planDate: taskDraft.planDate || today,
          priority: taskDraft.priority || 'medium',
          status: taskDraft.status || 'plan',
          chatId: taskDraft.chatId || '',
          movedFromDate: '',
          createdAt: new Date().toISOString()
      };
      setTasks((prev) => [createdTask, ...prev]);
      setSelectedTaskId(createdTask.id);
      setTaskDraft((prev) => ({
          ...prev,
          title: '',
          description: '',
          dueDate: '',
          planDate: prev.planDate || today,
          priority: 'medium',
          status: 'plan'
      }));
  };

  const handleCreateTaskFromCurrentChat = () => {
      if (!selectedDialog) return;
      setActiveTab('tasks');
      setTaskDraft((prev) => ({
          ...prev,
          chatId: String(selectedDialog.id),
          planDate: prev.planDate || getTodayDateValue(),
          title: prev.title || `Задача: ${selectedDialog.name}`
      }));
  };

  const handleQuickCreateTask = () => {
      const title = String(quickTaskTitle || '').trim();
      if (!title) return;
      const createdTask = {
          id: `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
          title,
          description: '',
          dueDate: '',
          planDate: getTodayDateValue(),
          priority: 'medium',
          status: 'plan',
          chatId: taskDraft.chatId || '',
          movedFromDate: '',
          createdAt: new Date().toISOString()
      };
      setTasks((prev) => [createdTask, ...prev]);
      setSelectedTaskId(createdTask.id);
      setQuickTaskTitle('');
  };

  const handleCreateTasksFromLines = () => {
      const lines = String(bulkTaskText || '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
      if (lines.length === 0) return;
      const nowIso = new Date().toISOString();
      const created = lines.map((title, index) => ({
          id: `task-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`,
          title,
          description: '',
          dueDate: taskDraft.dueDate || '',
          planDate: taskDraft.planDate || getTodayDateValue(),
          priority: taskDraft.priority || 'medium',
          status: taskDraft.status || 'plan',
          chatId: taskDraft.chatId || '',
          movedFromDate: '',
          createdAt: nowIso
      }));
      setTasks((prev) => [...created, ...prev]);
      setSelectedTaskId(created[0]?.id || null);
      setBulkTaskText('');
  };

  const handleTaskFieldUpdate = (taskId, patch) => {
      upsertTask(taskId, (task) => ({ ...task, ...patch }));
  };

  const handleTaskStatusChange = (taskId, nextStatus) => {
      upsertTask(taskId, (task) => ({ ...task, status: nextStatus }));
  };

  const handleTaskDelete = (taskId) => {
      setTasks((prev) => prev.filter((task) => task.id !== taskId));
      setSelectedTaskId((prev) => (prev === taskId ? null : prev));
  };

  const handleTaskMoveToTomorrow = (taskId) => {
      const tomorrow = getTomorrowDateValue();
      const today = getTodayDateValue();
      upsertTask(taskId, (task) => ({
          ...task,
          planDate: tomorrow,
          status: task.status === 'done' ? 'plan' : task.status,
          movedFromDate: today
      }));
  };

  useEffect(() => {
      if (true) return undefined; // moved to backend scheduler
      if (!isAuthenticated) return undefined;

      const runOnce = async () => {
          if (reminderProcessingRef.current) return;
          reminderProcessingRef.current = true;
          try {
              const nowTs = Date.now();
              const dueTasks = tasks.filter((task) => {
                  if (!task?.reminderAt || task?.reminderSentAt) return false;
                  const reminderTs = new Date(task.reminderAt).getTime();
                  if (!Number.isFinite(reminderTs)) return false;
                  return reminderTs <= nowTs;
              });
              if (!dueTasks.length) return;

              const sentTaskIds = [];
              for (const task of dueTasks) {
                  try {
                      await sendTelegramReminderMessage(buildTaskReminderText(task));
                      sentTaskIds.push(task.id);
                  } catch (error) {
                      console.error('Помилка одноразового нагадування:', error);
                  }
              }

              if (sentTaskIds.length) {
                  const sentAt = new Date().toISOString();
                  setTasks((prev) => prev.map((task) => (
                      sentTaskIds.includes(task.id) ? { ...task, reminderSentAt: sentAt } : task
                  )));
              }
          } finally {
              reminderProcessingRef.current = false;
          }
      };

      runOnce();
      const timer = setInterval(runOnce, 30000);
      return () => clearInterval(timer);
  }, [isAuthenticated, tasks]);

  useEffect(() => {
      if (true) return undefined; // moved to backend scheduler
      if (!isAuthenticated) return undefined;
      if (!taskReminderSettings.enabled || !taskReminderSettings.time || !taskBotSettings.enabled) return undefined;

      const runDaily = async () => {
          if (dailyDigestProcessingRef.current) return;
          dailyDigestProcessingRef.current = true;
          try {
              const nowTime = getCurrentTimeValue();
              const today = getTodayDateValue();
              if (nowTime !== taskReminderSettings.time) return;
              if (taskReminderSettings.lastSentDate === today) return;

              const todayTasks = tasks.filter((task) => String(task.planDate || '') === today);
              const message = buildDailyDigestText(todayTasks, today);
              await sendTelegramReminderMessage(message);
              setTaskReminderSettings((prev) => ({ ...prev, lastSentDate: today }));
          } catch (error) {
              console.error('Помилка щоденного дайджесту:', error);
          } finally {
              dailyDigestProcessingRef.current = false;
          }
      };

      runDaily();
      const timer = setInterval(runDaily, 15000);
      return () => clearInterval(timer);
  }, [isAuthenticated, taskReminderSettings, taskBotSettings.enabled, tasks]);


  const loadTaskBotSettings = async () => {
      try {
          const res = await fetch(`${API_URL}/settings/bot`);
          const data = await parseApiJson(res, 'Не вдалося завантажити налаштування бота');
          setTaskBotSettings({
              enabled: !!data?.enabled,
              hasToken: !!data?.hasToken,
              chatId: String(data?.chatId || '')
          });
          setTaskBotChatIdDraft(String(data?.chatId || ''));
      } catch (error) {
          console.error(error);
      }
  };

  const saveTaskBotSettings = async () => {
      try {
          const res = await fetch(`${API_URL}/settings/bot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  token: taskBotTokenDraft,
                  chatId: taskBotChatIdDraft,
                  enabled: taskBotSettings.enabled
              })
          });
          await parseApiJson(res, 'Не вдалося зберегти налаштування бота');
          await loadTaskBotSettings();
          setTaskBotTokenDraft('');
          alert('Налаштування бота збережено');
      } catch (error) {
          alert(error.message || 'Помилка збереження налаштувань бота');
      }
  };

  const sendTaskBotTest = async () => {
      try {
          const res = await fetch(`${API_URL}/settings/bot/test`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: 'Тест: бот нагадувань підключений успішно.' })
          });
          await parseApiJson(res, 'Не вдалося надіслати тест');
          alert('Тестове повідомлення надіслано');
      } catch (error) {
          alert(error.message || 'Помилка тестового повідомлення');
      }
  };

  useEffect(() => {
      if (activeTab === 'tasks') loadTaskBotSettings();
  }, [activeTab]);

  const getNormalizedPlaceCount = (values) => {
      const raw = Number.parseInt(String(values?.place_count || '1'), 10);
      if (!Number.isFinite(raw)) return 1;
      return Math.min(10, Math.max(1, raw));
  };

  const getPlaceDimensionsArray = (values, placeCount) => {
      const raw = Array.isArray(values?.place_dimensions) ? values.place_dimensions : [];
      return Array.from({ length: placeCount }, (_, index) => String(raw[index] || ''));
  };

  const buildCargoFromPlaces = (values) => {
      const placeCount = getNormalizedPlaceCount(values);
      const placeDimensions = getPlaceDimensionsArray(values, placeCount);
      const lines = placeDimensions
          .map((dimension, index) => `Місце ${index + 1}: ${dimension || '—'}`)
          .join('\n');

      return {
          cargo_packages: `${placeCount}`,
          cargo_dimensions: lines
      };
  };

  const isRequestFieldVisible = (field, values) => {
      if (!field.visibleWhen) return true;
      return String(values?.[field.visibleWhen.field] || '') === String(field.visibleWhen.equals || '');
  };

  const renderRequestPreview = (template, values) => {
      if (!template) return '';

      if (template.code === 'warehouse_issue_request') {
          const mentionField = template.fields.find((field) => field.key === 'selected_mentions');
          const defaultMentions = Array.isArray(mentionField?.defaultMentions) ? mentionField.defaultMentions : [];
          const selectedMentions = Array.isArray(values?.selected_mentions) ? values.selected_mentions : [];
          const mentionsLine = [...defaultMentions, ...selectedMentions]
              .map((mention) => {
                  const trimmed = String(mention || '').trim();
                  if (!trimmed) return null;
                  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
              })
              .filter(Boolean)
              .filter((mention, index, arr) => arr.indexOf(mention) === index)
              .join(' ');

          const mode = String(values?.request_mode || 'reservation');
          const modeBlock = mode === 'issuance'
              ? `Тип: "Видача"\nВидача на: "${values?.issue_recipient_type === 'contractor' ? 'Підрядник' : 'Кінцевий споживач'}"${values?.issue_recipient_name ? `\nХто саме: "${values.issue_recipient_name}"` : ''}`
              : `Прошу забронювати.${values?.project_name ? `\nПроєкт: "${values.project_name}"` : ''}`;

          const commentBlock = String(values?.additional_comment || '').trim()
              ? `\nДодатковий коментар:\n"${String(values.additional_comment).trim()}"\n`
              : '';

          return template.body_template
              .replace('{{mentions_line}}', mentionsLine)
              .replace('{{items_list}}', String(values?.items_list || '').trim())
              .replace('{{mode_block}}', modeBlock)
              .replace('{{comment_block}}', commentBlock)
              .trim();
      }

      if (template.code === 'logistics_request') {
          const selectedWarehouse = logisticsOptions.warehouses.find(option => String(option.value) === String(values?.pickup_template_id || ''));
          const selectedRecipient = logisticsOptions.recipients.find(option => String(option.value) === String(values?.delivery_template_id || ''));

          const boolFlag = (value, truthy = 'yes') => String(value || 'no') === truthy;
          const checkbox = (label, checked) => `${checked ? '☑' : '☐'} ${label}`;

          const specialConditions = boolFlag(values?.special_conditions_required);
          const needLoaders = boolFlag(values?.need_loaders);
          const needReturnDocs = boolFlag(values?.need_return_docs);
          const priority = String(values?.priority || 'standard');
          const priorityOther = String(values?.priority_other || '').trim();
          const cargoFromPlaces = buildCargoFromPlaces(values);
          const paymentForm = String(values?.payment_form || 'cash');
          const paymentFormOther = String(values?.payment_form_other || '').trim();
          const paymentFormLabel = paymentForm === 'cash'
              ? 'готівка'
              : paymentForm === 'cashless_vat'
                  ? 'безготівка з ПДВ'
                  : paymentForm === 'other'
                      ? paymentFormOther
                      : paymentForm;

          const valueOrTemplate = (key, templateValue) => {
              const own = String(values?.[key] || '').trim();
              if (own) return own;
              return String(templateValue || '').trim();
          };

          const previewValues = {
              ...values,
              submission_date: String(values?.submission_date || '').trim(),
              requester_name_division: String(values?.requester_name_division || '').trim(),
              requester_phone: String(values?.requester_phone || '').trim(),
              cargo_type: String(values?.cargo_type || '').trim(),
              cargo_packages: cargoFromPlaces.cargo_packages,
              cargo_weight_kg: String(values?.cargo_weight_kg || '').trim(),
              cargo_dimensions: cargoFromPlaces.cargo_dimensions,
              longest_part_length: String(values?.longest_part_length || '').trim(),
              payment_form: String(paymentFormLabel || '').trim(),
              invoice_legal_entity: String(values?.invoice_legal_entity || '').trim(),
              payment_docs_note: String(values?.payment_docs_note || '').trim(),
              pickup_object_name: valueOrTemplate('pickup_object_name', selectedWarehouse?.label),
              pickup_work_schedule: valueOrTemplate('pickup_work_schedule', selectedWarehouse?.workSchedule),
              pickup_address: valueOrTemplate('pickup_address', selectedWarehouse?.address),
              pickup_geolocation: valueOrTemplate('pickup_geolocation', selectedWarehouse?.geoLink),
              pickup_contact_person: valueOrTemplate('pickup_contact_person', selectedWarehouse?.contactPerson),
              pickup_contact_phone: valueOrTemplate('pickup_contact_phone', selectedWarehouse?.contactPhone),
              pickup_ready_time: String(values?.pickup_ready_time || '').trim(),
              pickup_loading_method: valueOrTemplate('pickup_loading_method', selectedWarehouse?.loadingType),
              delivery_object_name: valueOrTemplate('delivery_object_name', selectedRecipient?.label),
              delivery_address: valueOrTemplate('delivery_address', selectedRecipient?.address),
              delivery_contact_person: valueOrTemplate('delivery_contact_person', selectedRecipient?.contactPerson),
              delivery_contact_phone: valueOrTemplate('delivery_contact_phone', selectedRecipient?.contactPhone),
              delivery_desired_time: valueOrTemplate('delivery_desired_time', selectedRecipient?.deliveryTimeNote),
              delivery_unloading_method: valueOrTemplate('delivery_unloading_method', selectedRecipient?.unloadingType),
              additional_notes: String(values?.additional_notes || '').trim(),
              driver_waybill_note: String(values?.driver_waybill_note || '').trim(),
              special_conditions_no_line: checkbox('Ні', !specialConditions),
              special_conditions_yes_line: checkbox(`Так (уточнити: ${String(values?.special_conditions_note || '').trim() || '_______________________'})`, specialConditions),
              need_loaders_yes_line: checkbox('Так', needLoaders),
              need_loaders_no_line: checkbox('Ні', !needLoaders),
              need_return_docs_yes_line: checkbox('Так', needReturnDocs),
              need_return_docs_no_line: checkbox('Ні', !needReturnDocs),
              priority_standard_line: checkbox('Стандартна доставка (в межах 3-4 днів)', priority === 'standard'),
              priority_urgent_line: checkbox('Термінова доставка (в межах 1-2 дня)', priority === 'urgent'),
              priority_other_line: checkbox(`Інше: ${priorityOther || '_____________________'}`, priority === 'other')
          };

          return template.body_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
              const value = previewValues[key];
              return value == null ? '' : String(value);
          }).trim();
      }

      if (template.code === 'purchase_request') {
          const paymentFormMap = {
              pdv: 'ПДВ',
              fop: 'ФОП',
              cash: 'Готівка',
              other: String(values?.payment_form_other || '').trim() || 'Інше'
          };
          const deliveryPaymentMap = {
              cashless: 'Безнал',
              cash: 'Готівка',
              other: String(values?.delivery_payment_other || '').trim() || 'Інше'
          };

          const previewValues = {
              ...values,
              payment_form: paymentFormMap[String(values?.payment_form || '')] || String(values?.payment_form || ''),
              delivery_payment: deliveryPaymentMap[String(values?.delivery_payment || '')] || String(values?.delivery_payment || '')
          };

          return template.body_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
              const value = previewValues[key];
              return value == null ? '' : String(value);
          }).trim();
      }

      return template.body_template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
          const value = values[key];
          return value == null ? '' : String(value);
      });
  };

  const requestPreview = React.useMemo(() => {
      return renderRequestPreview(selectedRequestTemplate, requestFormValues);
  }, [selectedRequestTemplate, requestFormValues, logisticsOptions]);

  const loadRequestTemplates = async () => {
      setLoadingRequests(true);
      try {
          const res = await fetch(`${API_URL}/requests/templates?v=${Date.now()}`, { cache: 'no-store' });
          const data = await res.json();
          if (!Array.isArray(data)) return;

          setRequestTemplates(data);

          if (data.length === 0) {
              setSelectedRequestTemplateId(null);
              setRequestFormValues({});
              return;
          }

          const nextTemplate = data.find(template => template.id === selectedRequestTemplateId) || data[0];
          setSelectedRequestTemplateId(nextTemplate.id);
          setRequestFormValues(prev => {
              const nextValues = {};
              nextTemplate.fields.forEach(field => {
                  nextValues[field.key] = prev[field.key] ?? getRequestFieldDefaultValue(field);
              });
              if (nextTemplate.code === 'logistics_request') {
                  const placeCount = Math.min(10, Math.max(1, Number.parseInt(String(prev.place_count || '1'), 10) || 1));
                  nextValues.place_count = String(placeCount);
                  const prevDimensions = Array.isArray(prev.place_dimensions) ? prev.place_dimensions : [];
                  nextValues.place_dimensions = Array.from({ length: placeCount }, (_, index) => String(prevDimensions[index] || ''));
              }
              return nextValues;
          });
      } catch (error) {
          console.error(error);
      } finally {
          setLoadingRequests(false);
      }
  };

  const loadDocumentTemplates = async () => {
      setLoadingDocumentTemplates(true);
      setDocumentError('');
      try {
          const [categoriesRes, templatesRes, permissionsRes] = await Promise.all([
              fetch(`${API_URL}/documents/categories?includeInactive=1&v=${Date.now()}`, { cache: 'no-store' }),
              fetch(`${API_URL}/documents/templates?includeInactive=1&v=${Date.now()}`, { cache: 'no-store' }),
              fetch(`${API_URL}/documents/permissions?v=${Date.now()}`, { cache: 'no-store' })
          ]);
          const categories = await categoriesRes.json();
          const templates = await templatesRes.json();
          const permissions = await permissionsRes.json();

          setDocumentCategories(sortCategoriesByOrder(Array.isArray(categories) ? categories : []));
          setDocumentTemplates(Array.isArray(templates) ? templates : []);
          setCanManageDocuments(Boolean(permissions?.canManage));
      } catch (error) {
          console.error(error);
          setDocumentError('Не вдалося завантажити шаблони документів');
      } finally {
          setLoadingDocumentTemplates(false);
      }
  };

  const loadWarehouseOrders = async () => {
      setWarehouseOrdersLoading(true);
      try {
          const [ordersRes, permissionsRes] = await Promise.all([
              fetch(`${API_URL}/orders?v=${Date.now()}`, { cache: 'no-store' }),
              fetch(`${API_URL}/orders/permissions?v=${Date.now()}`, { cache: 'no-store' })
          ]);
          const orders = await parseApiJson(ordersRes, 'Не вдалося завантажити замовлення');
          const permissions = await parseApiJson(permissionsRes, 'Не вдалося завантажити права по замовленнях');
          setWarehouseOrders(Array.isArray(orders) ? orders : []);
          setCanManageWarehouseOrders(Boolean(permissions?.canManage));
      } catch (error) {
          alert(error.message || 'Помилка завантаження замовлень');
      } finally {
          setWarehouseOrdersLoading(false);
      }
  };

  const createWarehouseOrderFromMessage = async (message) => {
      if (!selectedDialog || !message) return;
      try {
          const res = await fetch(`${API_URL}/orders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  chatId: String(selectedDialog.id),
                  chatName: String(selectedDialog.name || ''),
                  messageId: Number(message.id),
                  messageText: String(message.text || ''),
                  mediaPath: String(message.mediaPath || ''),
                  mediaName: String(message.mediaName || ''),
                  requesterName: String(currentUser || ''),
                  requestType: 'issuance'
              })
          });
          await parseApiJson(res, 'Не вдалося створити замовлення');
          alert('Замовлення створено у розділі "Замовлення (Склад)"');
      } catch (error) {
          alert(error.message || 'Помилка створення замовлення');
      }
  };

  const updateWarehouseOrderStatus = async (orderId, status) => {
      try {
          const res = await fetch(`${API_URL}/orders/${orderId}/status`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status })
          });
          const updated = await parseApiJson(res, 'Не вдалося змінити статус');
          setWarehouseOrders((prev) => prev.map((order) => (Number(order.id) === Number(orderId) ? updated : order)));
      } catch (error) {
          alert(error.message || 'Помилка зміни статусу');
      }
  };

  const openWarehouseOrderEditor = (order) => {
      setEditingWarehouseOrder({
          id: order.id,
          messageText: String(order.message_text || ''),
          projectName: String(order.project_name || ''),
          requesterName: String(order.requester_name || order.created_by_username || ''),
          requestType: String(order.request_type || 'issuance') === 'reservation' ? 'reservation' : 'issuance'
      });
      setEditingWarehouseOrderFile(null);
      setExpandedOrder(order);
  };

  const saveWarehouseOrderEdits = async () => {
      if (!editingWarehouseOrder?.id) return;
      try {
          const form = new FormData();
          form.append('messageText', String(editingWarehouseOrder.messageText || ''));
          form.append('projectName', String(editingWarehouseOrder.projectName || ''));
          form.append('requesterName', String(editingWarehouseOrder.requesterName || ''));
          form.append('requestType', String(editingWarehouseOrder.requestType || 'issuance'));
          if (editingWarehouseOrderFile) form.append('file', editingWarehouseOrderFile);
          const res = await fetch(`${API_URL}/orders/${editingWarehouseOrder.id}`, {
              method: 'PATCH',
              body: form
          });
          const updated = await parseApiJson(res, 'Не вдалося зберегти зміни замовлення');
          setWarehouseOrders((prev) => prev.map((order) => (Number(order.id) === Number(updated.id) ? updated : order)));
          setExpandedOrder(updated);
          setEditingWarehouseOrder((prev) => prev ? ({ ...prev, id: updated.id }) : null);
          setEditingWarehouseOrderFile(null);
          alert('Замовлення оновлено');
      } catch (error) {
          alert(error.message || 'Помилка збереження замовлення');
      }
  };

  const createManualWarehouseOrder = async () => {
      const messageText = String(manualWarehouseOrder.messageText || '').trim();
      const projectName = String(manualWarehouseOrder.projectName || '').trim();
      const requesterName = String(manualWarehouseOrder.requesterName || '').trim();
      const requestType = String(manualWarehouseOrder.requestType || 'issuance') === 'reservation' ? 'reservation' : 'issuance';
      if (!messageText && !manualWarehouseOrderFile) {
          alert('Додай опис або файл замовлення');
          return;
      }
      try {
          const form = new FormData();
          form.append('chatId', '');
          form.append('chatName', '');
          form.append('messageText', messageText);
          form.append('projectName', projectName);
          form.append('requesterName', requesterName);
          form.append('requestType', requestType);
          if (manualWarehouseOrderFile) form.append('file', manualWarehouseOrderFile);
          const res = await fetch(`${API_URL}/orders`, {
              method: 'POST',
              body: form
          });
          const created = await parseApiJson(res, 'Не вдалося створити замовлення');
          setWarehouseOrders((prev) => [created, ...prev]);
          setManualWarehouseOrder({ messageText: '', projectName: '', requesterName: '', requestType: 'issuance' });
          setManualWarehouseOrderFile(null);
          alert('Замовлення додано вручну');
      } catch (error) {
          alert(error.message || 'Помилка створення замовлення');
      }
  };

  const handleCreateDocumentCategory = async () => {
      const name = String(newDocumentCategory || '').trim();
      if (!name) return;
      try {
          const res = await fetch(`${API_URL}/documents/categories`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name })
          });
          const data = await parseApiJson(res, 'Не вдалося створити категорію');
          setDocumentCategories((prev) => sortCategoriesByOrder([...prev, data]));
          setNewDocumentCategory('');
      } catch (error) {
          alert(error.message || 'Помилка створення категорії');
      }
  };

  const handleCreateDocumentTemplate = async () => {
      const payload = {
          categoryId: newDocumentTemplate.categoryId,
          title: newDocumentTemplate.title,
          description: newDocumentTemplate.description,
          fileUrl: newDocumentTemplate.fileUrl
      };
      if (!payload.categoryId || !String(payload.title || '').trim() || !String(payload.fileUrl || '').trim()) {
          alert('Оберіть категорію, вкажіть назву та посилання');
          return;
      }
      try {
          const res = await fetch(`${API_URL}/documents/templates`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
          });
          const data = await parseApiJson(res, 'Не вдалося створити шаблон');
          setDocumentTemplates((prev) => [...prev, data]);
          setNewDocumentTemplate({ categoryId: payload.categoryId, title: '', description: '', fileUrl: '' });
      } catch (error) {
          alert(error.message || 'Помилка створення шаблону');
      }
  };

  const handleStartEditDocumentTemplate = (template) => {
      setEditingDocumentTemplateId(template.id);
      setEditingDocumentTemplate({
          categoryId: String(template.category_id || ''),
          title: template.title || '',
          description: template.description || '',
          fileUrl: template.file_url || ''
      });
  };

  const handleCancelEditDocumentTemplate = () => {
      setEditingDocumentTemplateId(null);
      setEditingDocumentTemplate({ categoryId: '', title: '', description: '', fileUrl: '' });
  };

  const handleSaveDocumentTemplate = async (templateId) => {
      const payload = {
          categoryId: editingDocumentTemplate.categoryId,
          title: editingDocumentTemplate.title,
          description: editingDocumentTemplate.description,
          fileUrl: editingDocumentTemplate.fileUrl
      };
      if (!payload.categoryId || !String(payload.title || '').trim() || !String(payload.fileUrl || '').trim()) {
          alert('Заповніть категорію, назву і посилання');
          return;
      }
      try {
          const res = await fetch(`${API_URL}/documents/templates/${templateId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
          });
          const updated = await parseApiJson(res, 'Не вдалося оновити шаблон');
          setDocumentTemplates((prev) => prev.map((item) => (item.id === templateId ? updated : item)));
          handleCancelEditDocumentTemplate();
      } catch (error) {
          alert(error.message || 'Помилка оновлення шаблону');
      }
  };

  const handleDeleteDocumentTemplate = async (templateId) => {
      if (!window.confirm('Видалити цей шаблон документа?')) return;
      try {
          const res = await fetch(`${API_URL}/documents/templates/${templateId}`, { method: 'DELETE' });
          await parseApiJson(res, 'Не вдалося видалити шаблон');
          setDocumentTemplates((prev) => prev.filter((item) => item.id !== templateId));
          if (editingDocumentTemplateId === templateId) {
              handleCancelEditDocumentTemplate();
          }
      } catch (error) {
          alert(error.message || 'Помилка видалення шаблону');
      }
  };

  const handleMoveDocumentCategory = async (categoryId, direction) => {
      const ordered = sortCategoriesByOrder(documentCategories);
      const currentIndex = ordered.findIndex((category) => String(category.id) === String(categoryId));
      if (currentIndex === -1) return;

      const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= ordered.length) return;

      const current = ordered[currentIndex];
      const target = ordered[targetIndex];

      try {
          const [firstRes, secondRes] = await Promise.all([
              fetch(`${API_URL}/documents/categories/${current.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sortOrder: target.sort_order })
              }),
              fetch(`${API_URL}/documents/categories/${target.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sortOrder: current.sort_order })
              })
          ]);

          const firstData = await parseApiJson(firstRes, 'Не вдалося змінити порядок категорій');
          const secondData = await parseApiJson(secondRes, 'Не вдалося змінити порядок категорій');

          setDocumentCategories((prev) => {
              const next = prev.map((category) => {
                  if (category.id === firstData.id) return firstData;
                  if (category.id === secondData.id) return secondData;
                  return category;
              });
              return sortCategoriesByOrder(next);
          });
      } catch (error) {
          alert(error.message || 'Помилка зміни порядку категорій');
      }
  };

  const loadAdminUsers = async () => {
      if (!isSystemAdmin) return;
      setLoadingAdminUsers(true);
      try {
          const res = await fetch(`${API_URL}/system/users`);
          const data = await parseApiJson(res, 'Не вдалося завантажити користувачів');
          const users = Array.isArray(data?.users) ? data.users : [];
          setAdminUsers(users);
          if (!selectedAdminUserId && users.length > 0) {
              setSelectedAdminUserId(String(users[0].id));
          }
      } catch (error) {
          alert(error.message || 'Помилка завантаження користувачів');
      } finally {
          setLoadingAdminUsers(false);
      }
  };

  const loadAdminPermissions = async (userId) => {
      if (!isSystemAdmin || !userId) return;
      try {
          const res = await fetch(`${API_URL}/system/users/${userId}/permissions`);
          const data = await parseApiJson(res, 'Не вдалося завантажити доступи');
          setSelectedAdminPermissions(data?.permissions || {});
      } catch (error) {
          alert(error.message || 'Помилка завантаження доступів');
      }
  };

  const handleAdminRoleChange = async (userId, role) => {
      try {
          const res = await fetch(`${API_URL}/system/users/${userId}/role`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role })
          });
          const data = await parseApiJson(res, 'Не вдалося змінити роль');
          setAdminUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: data?.user?.role || role } : u)));
      } catch (error) {
          alert(error.message || 'Помилка зміни ролі');
      }
  };

  const handlePermissionToggle = async (key, value) => {
      if (!selectedAdminUserId) return;
      try {
          const res = await fetch(`${API_URL}/system/users/${selectedAdminUserId}/permissions`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions: { [key]: value } })
          });
          const data = await parseApiJson(res, 'Не вдалося оновити доступ');
          setSelectedAdminPermissions(data?.permissions || {});
      } catch (error) {
          alert(error.message || 'Помилка оновлення доступу');
      }
  };

  useEffect(() => { if (activeTab === 'adminUsers') loadAdminUsers(); }, [activeTab, isSystemAdmin]);
  useEffect(() => { if (activeTab === 'adminUsers' && selectedAdminUserId) loadAdminPermissions(selectedAdminUserId); }, [activeTab, selectedAdminUserId]);
  useEffect(() => { if (activeTab === 'warehouseOrders') loadWarehouseOrders(); }, [activeTab]);


  const handleSelectRequestTemplate = (template) => {
      setSelectedRequestTemplateId(template.id);
      setRequestFeedback(null);
      setRequestChatSearch('');
      setPurchaseImportText('');
      setPurchaseImportRows([]);
      setPurchaseImportError('');
      setPurchaseManualItem({ itemName: '', equipmentCode: '', plant: '', unit: '', qty: '', notes: '' });
      setRequestFormValues(prev => {
          const nextValues = {};
          template.fields.forEach(field => {
              nextValues[field.key] = prev[field.key] ?? getRequestFieldDefaultValue(field);
          });
          if (template.code === 'logistics_request') {
              const placeCount = Math.min(10, Math.max(1, Number.parseInt(String(prev.place_count || '1'), 10) || 1));
              nextValues.place_count = String(placeCount);
              const prevDimensions = Array.isArray(prev.place_dimensions) ? prev.place_dimensions : [];
              nextValues.place_dimensions = Array.from({ length: placeCount }, (_, index) => String(prevDimensions[index] || ''));
          }
          return nextValues;
      });
  };

  const handleRequestFieldChange = (key, value) => {
      setRequestFeedback(null);
      setRequestFormValues(prev => ({ ...prev, [key]: value }));
  };

  const parsePurchaseImportRows = (rawText) => {
      const isLikelyQty = (value) => /^-?\d+([.,]\d+)?$/.test(String(value || '').trim());
      const isLikelyUnit = (value) => {
          const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
          return ['шт', 'шт.', 'кг', 'г', 'м', 'м2', 'м3', 'л', 'пач', 'пач.', 'компл', 'компл.', 'пар', 'пара', 'рул', 'рул.'].includes(normalized);
      };

      const lines = String(rawText || '')
          .replace(/\r/g, '\n')
          .split('\n')
          .map(line => line.trim())
          .filter(Boolean);

      return lines.map((line, index) => {
          const cells = line.split('\t').map(cell => String(cell || '').trim());
          if (cells.length === 0) return null;

          // Skip header rows accidentally copied from Excel
          const loweredJoined = cells.join(' ').toLowerCase();
          if (loweredJoined.includes('найменування') && loweredJoined.includes('код') && loweredJoined.includes('к-сть')) {
              return null;
          }

          while (cells.length > 0 && !cells[cells.length - 1]) {
              cells.pop();
          }
          if (cells.length === 0) return null;

          const itemName = cells[0] || '';
          const equipmentCode = cells[1] || '';
          const tail = cells.slice(2);

          let qtyIndex = -1;
          for (let i = tail.length - 1; i >= 0; i -= 1) {
              if (isLikelyQty(tail[i])) {
                  qtyIndex = i;
                  break;
              }
          }
          if (qtyIndex === -1 && tail.length > 0) {
              qtyIndex = tail.length - 1;
          }

          let unitIndex = -1;
          if (qtyIndex > 0) {
              for (let i = qtyIndex - 1; i >= 0; i -= 1) {
                  if (isLikelyUnit(tail[i])) {
                      unitIndex = i;
                      break;
                  }
              }
              if (unitIndex === -1) {
                  unitIndex = qtyIndex - 1;
              }
          }

          const qty = qtyIndex >= 0 ? (tail[qtyIndex] || '') : '';
          const unit = unitIndex >= 0 ? (tail[unitIndex] || '') : '';

          const plantParts = tail.filter((_, idx) => idx >= 0 && idx < (unitIndex >= 0 ? unitIndex : Math.max(qtyIndex, 0)));
          const plant = plantParts.filter(Boolean).join(' | ');

          const notesParts = tail.filter((_, idx) => idx > qtyIndex);
          const notes = notesParts.filter(Boolean).join(' | ');

          return {
              rowNumber: index + 1,
              itemName,
              equipmentCode,
              plant,
              unit,
              qty,
              notes
          };
      }).filter(Boolean);
  };

  const formatPurchaseItemsList = (rows) => {
      return rows
          .map((row, index) => {
              const parts = [];
              if (row.itemName) parts.push(row.itemName);
              if (row.equipmentCode) parts.push(`код: ${row.equipmentCode}`);
              if (row.plant) parts.push(`завод: ${row.plant}`);
              if (row.unit) parts.push(`од.: ${row.unit}`);
              if (row.qty) parts.push(`к-сть: ${row.qty}`);
              if (row.notes) parts.push(`примітки: ${row.notes}`);
              return `${index + 1}. ${parts.join(' | ')}`.trim();
          })
          .join('\n');
  };

  const handleParsePurchaseImport = () => {
      const parsedRows = parsePurchaseImportRows(purchaseImportText);
      if (parsedRows.length === 0) {
          setPurchaseImportRows([]);
          setPurchaseImportError('Не вдалося розпізнати рядки. Скопіюй рядки напряму з Excel і встав сюди.');
          return;
      }
      setPurchaseImportError('');
      setPurchaseImportRows(parsedRows.map((row, index) => ({ ...row, rowNumber: index + 1, source: 'import' })));
  };

  const syncPurchaseRowsToForm = (rows) => {
      const itemsListText = formatPurchaseItemsList(rows);
      setRequestFormValues(prev => ({
          ...prev,
          items_list: itemsListText,
          purchase_items_json: JSON.stringify(rows)
      }));
  };

  const handleApplyPurchaseImport = () => {
      const rawText = String(purchaseImportText || '').trim();
      const parsedFromText = rawText ? parsePurchaseImportRows(rawText) : [];
      const manualRows = purchaseImportRows.filter((row) => row?.source === 'manual');
      const importRows = parsedFromText.length > 0
          ? parsedFromText.map((row) => ({ ...row, source: 'import' }))
          : purchaseImportRows.filter((row) => row?.source !== 'manual').map((row) => ({ ...row, source: 'import' }));
      const rows = [...importRows, ...manualRows].map((row, index) => ({ ...row, rowNumber: index + 1 }));
      if (rows.length === 0) {
          setPurchaseImportError('Немає даних для підстановки.');
          return;
      }

      setRequestFeedback(null);
      setPurchaseImportError('');
      setPurchaseImportRows(rows);
      syncPurchaseRowsToForm(rows);
  };

  const handleAddManualPurchaseItem = () => {
      const nextItem = {
          itemName: String(purchaseManualItem.itemName || '').trim(),
          equipmentCode: String(purchaseManualItem.equipmentCode || '').trim(),
          plant: String(purchaseManualItem.plant || '').trim(),
          unit: String(purchaseManualItem.unit || '').trim(),
          qty: String(purchaseManualItem.qty || '').trim(),
          notes: String(purchaseManualItem.notes || '').trim()
      };
      if (!nextItem.itemName) {
          setPurchaseImportError('Для ручного додавання заповни хоча б "Найменування".');
          return;
      }
      const rawText = String(purchaseImportText || '').trim();
      const importRows = rawText
          ? parsePurchaseImportRows(rawText).map((row) => ({ ...row, source: 'import' }))
          : purchaseImportRows.filter((row) => row?.source !== 'manual').map((row) => ({ ...row, source: 'import' }));
      const manualRows = purchaseImportRows.filter((row) => row?.source === 'manual');
      const nextRows = [...importRows, ...manualRows, { ...nextItem, source: 'manual' }]
          .map((row, index) => ({ ...row, rowNumber: index + 1 }));
      setPurchaseImportError('');
      setPurchaseImportRows(nextRows);
      syncPurchaseRowsToForm(nextRows);
      setPurchaseManualItem({ itemName: '', equipmentCode: '', plant: '', unit: '', qty: '', notes: '' });
  };

  const applyPurchaseManagerTemplateById = (templateId) => {
      const selected = purchaseTemplateOptions.managers.find(item => String(item.value) === String(templateId));
      if (!selected) return;
      handleRequestFieldChange('manager_name', selected.label);
  };

  const applyPurchaseAddressTemplateById = (templateId) => {
      const selected = purchaseTemplateOptions.addresses.find(item => String(item.value) === String(templateId));
      if (!selected) return;
      handleRequestFieldChange('delivery_address', selected.address || '');
  };

  const handleSavePurchaseManagerTemplate = async () => {
      const name = String(requestFormValues.manager_name || '').trim();
      if (!name) {
          setRequestFeedback({ type: 'error', text: 'Заповни поле "Менеджер", щоб зберегти шаблон.' });
          return;
      }
      setSavingPurchaseManagerTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/purchase/manager`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          await loadPurchaseTemplateOptions();
          setRequestFeedback({ type: 'success', text: 'Шаблон менеджера збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон менеджера.' });
      } finally {
          setSavingPurchaseManagerTemplate(false);
      }
  };

  const handleSavePurchaseAddressTemplate = async () => {
      const address = String(requestFormValues.delivery_address || '').trim();
      if (!address) {
          setRequestFeedback({ type: 'error', text: 'Заповни поле "Адреса доставки", щоб зберегти шаблон.' });
          return;
      }
      const title = address;
      setSavingPurchaseAddressTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/purchase/address`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title, address })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          await loadPurchaseTemplateOptions();
          setRequestFeedback({ type: 'success', text: 'Шаблон адреси збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон адреси.' });
      } finally {
          setSavingPurchaseAddressTemplate(false);
      }
  };

  const applyTkManagerTemplateById = (templateId) => {
      const selected = tkTemplateOptions.managers.find(item => String(item.value) === String(templateId));
      if (!selected) return;
      handleRequestFieldChange('manager_name', selected.label);
  };

  const applyTkRecipientTemplateById = (templateId) => {
      const selected = tkTemplateOptions.recipients.find(item => String(item.value) === String(templateId));
      if (!selected) return;
      handleRequestFieldChange('recipient_details', selected.details || '');
  };

  const handleSaveTkManagerTemplate = async () => {
      const name = String(requestFormValues.manager_name || '').trim();
      if (!name) {
          setRequestFeedback({ type: 'error', text: 'Заповни поле "Менеджер", щоб зберегти шаблон.' });
          return;
      }
      setSavingTkManagerTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/tk/manager`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          await loadTkTemplateOptions();
          setRequestFeedback({ type: 'success', text: 'Шаблон менеджера для ТК збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон менеджера для ТК.' });
      } finally {
          setSavingTkManagerTemplate(false);
      }
  };

  const handleSaveTkRecipientTemplate = async () => {
      const details = String(requestFormValues.recipient_details || '').trim();
      if (!details) {
          setRequestFeedback({ type: 'error', text: 'Заповни поле "Дані отримувача", щоб зберегти шаблон.' });
          return;
      }
      const firstLine = details.split('\n').map(line => line.trim()).find(Boolean) || 'Одержувач';
      const title = firstLine.slice(0, 80);

      setSavingTkRecipientTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/tk/recipient`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title, details })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          await loadTkTemplateOptions();
          setRequestFeedback({ type: 'success', text: 'Шаблон отримувача для ТК збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон отримувача для ТК.' });
      } finally {
          setSavingTkRecipientTemplate(false);
      }
  };

  const handleLogisticsPlaceCountChange = (nextCountValue) => {
      const nextCount = Math.min(10, Math.max(1, Number.parseInt(String(nextCountValue || '1'), 10) || 1));
      setRequestFeedback(null);
      setRequestFormValues(prev => {
          const current = Array.isArray(prev.place_dimensions) ? prev.place_dimensions : [];
          const resized = Array.from({ length: nextCount }, (_, index) => String(current[index] || ''));
          return {
              ...prev,
              place_count: String(nextCount),
              place_dimensions: resized
          };
      });
  };

  const handleLogisticsPlaceDimensionChange = (index, value) => {
      setRequestFeedback(null);
      setRequestFormValues(prev => {
          const count = getNormalizedPlaceCount(prev);
          const dimensions = getPlaceDimensionsArray(prev, count);
          dimensions[index] = value;
          return {
              ...prev,
              place_dimensions: dimensions
          };
      });
  };

  const applyPickupTemplateById = (templateId) => {
      const selected = logisticsOptions.warehouses.find(item => String(item.value) === String(templateId));
      setRequestFeedback(null);
      setRequestFormValues(prev => ({
          ...prev,
          pickup_template_id: templateId || '',
          pickup_object_name: selected?.label || prev.pickup_object_name || '',
          pickup_work_schedule: selected?.workSchedule || prev.pickup_work_schedule || '',
          pickup_address: selected?.address || prev.pickup_address || '',
          pickup_geolocation: selected?.geoLink || prev.pickup_geolocation || '',
          pickup_contact_person: selected?.contactPerson || prev.pickup_contact_person || '',
          pickup_contact_phone: selected?.contactPhone || prev.pickup_contact_phone || '',
          pickup_loading_method: selected?.loadingType || prev.pickup_loading_method || ''
      }));
  };

  const applyDeliveryTemplateById = (templateId) => {
      const selected = logisticsOptions.recipients.find(item => String(item.value) === String(templateId));
      setRequestFeedback(null);
      setRequestFormValues(prev => ({
          ...prev,
          delivery_template_id: templateId || '',
          delivery_object_name: selected?.label || prev.delivery_object_name || '',
          delivery_address: selected?.address || prev.delivery_address || '',
          delivery_contact_person: selected?.contactPerson || prev.delivery_contact_person || '',
          delivery_contact_phone: selected?.contactPhone || prev.delivery_contact_phone || '',
          delivery_desired_time: selected?.deliveryTimeNote || prev.delivery_desired_time || '',
          delivery_unloading_method: selected?.unloadingType || prev.delivery_unloading_method || ''
      }));
  };

  const handleSavePickupTemplate = async () => {
      const name = String(requestFormValues.pickup_object_name || '').trim();
      if (!name) {
          setRequestFeedback({ type: 'error', text: 'Заповни назву складу, щоб зберегти шаблон.' });
          return;
      }

      setSavingPickupTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/logistics/warehouse`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  name,
                  workSchedule: requestFormValues.pickup_work_schedule || '',
                  address: requestFormValues.pickup_address || '',
                  geoLink: requestFormValues.pickup_geolocation || '',
                  contactPerson: requestFormValues.pickup_contact_person || '',
                  contactPhone: requestFormValues.pickup_contact_phone || '',
                  loadingType: requestFormValues.pickup_loading_method || ''
              })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          await loadLogisticsOptions();
          applyPickupTemplateById(data.warehouse?.value || '');
          setRequestFeedback({ type: 'success', text: 'Шаблон складу збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон складу.' });
      } finally {
          setSavingPickupTemplate(false);
      }
  };

  const handleSaveDeliveryTemplate = async () => {
      const name = String(requestFormValues.delivery_object_name || '').trim();
      if (!name) {
          setRequestFeedback({ type: 'error', text: 'Заповни назву одержувача, щоб зберегти шаблон.' });
          return;
      }

      setSavingDeliveryTemplate(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/logistics/recipient`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  name,
                  recipientType: 'Одержувач',
                  address: requestFormValues.delivery_address || '',
                  contactPerson: requestFormValues.delivery_contact_person || '',
                  contactPhone: requestFormValues.delivery_contact_phone || '',
                  deliveryTimeNote: requestFormValues.delivery_desired_time || '',
                  unloadingType: requestFormValues.delivery_unloading_method || ''
              })
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);

          await loadLogisticsOptions();
          applyDeliveryTemplateById(data.recipient?.value || '');
          setRequestFeedback({ type: 'success', text: 'Шаблон одержувача збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти шаблон одержувача.' });
      } finally {
          setSavingDeliveryTemplate(false);
      }
  };

  const handleToggleRequestMention = (username) => {
      if (!username) return;
      setRequestFeedback(null);
      setRequestFormValues(prev => {
          const currentValues = Array.isArray(prev.selected_mentions) ? prev.selected_mentions : [];
          const normalized = username.startsWith('@') ? username : `@${username}`;
          const nextValues = currentValues.includes(normalized)
              ? currentValues.filter(item => item !== normalized)
              : [...currentValues, normalized];
          return { ...prev, selected_mentions: nextValues };
      });
  };

  const handleRequestAttachmentSelect = (file) => {
      setRequestFeedback(null);
      setRequestAttachment(file || null);
  };

  const handleRequestItemsPaste = (event) => {
      if (selectedRequestTemplate?.code !== 'warehouse_issue_request') return;
      const items = event.clipboardData?.items;
      if (!items || !items.length) return;

      for (let index = 0; index < items.length; index += 1) {
          const item = items[index];
          if (!item?.type || !item.type.startsWith('image/')) continue;
          const pastedImage = item.getAsFile();
          if (!pastedImage) continue;

          const extension = pastedImage.type.includes('png') ? 'png' : 'jpg';
          const preparedFile = new File(
              [pastedImage],
              `screenshot-${Date.now()}.${extension}`,
              { type: pastedImage.type || 'image/png' }
          );

          handleRequestAttachmentSelect(preparedFile);
          setRequestFeedback({ type: 'success', text: 'Скріншот додано до заявки.' });
          event.preventDefault();
          break;
      }
  };

  const clearRequestAttachment = () => {
      setRequestAttachment(null);
      if (requestFileInputRef.current) {
          requestFileInputRef.current.value = '';
      }
  };

  const handleSaveRequestTargetChat = async (chatId) => {
      const template = selectedRequestTemplate;
      if (!template) return;

      const matchedDialog = dialogs.find(dialog => String(dialog.id) === String(chatId));
      setRequestConfigSaving(true);
      setRequestFeedback(null);
      try {
          const res = await fetch(`${API_URL}/requests/templates/${template.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  targetChatId: chatId,
                  targetChatName: matchedDialog?.name || ''
              })
          });
          const data = await res.json();
          if (data.error) {
              throw new Error(data.error);
          }

          setRequestTemplates(prev => prev.map(item => item.id === data.id ? data : item));
          setRequestFeedback({ type: 'success', text: 'Чат для цієї заяви збережено.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося зберегти чат.' });
      } finally {
          setRequestConfigSaving(false);
      }
  };

  const handleSendRequest = async () => {
      if (!selectedRequestTemplate) return;

      setRequestSending(true);
      setRequestFeedback(null);
      try {
          const valuesForSend = (() => {
              if (selectedRequestTemplate.code !== 'logistics_request') return requestFormValues;
              const cargoFromPlaces = buildCargoFromPlaces(requestFormValues);
              return {
                  ...requestFormValues,
                  cargo_packages: cargoFromPlaces.cargo_packages,
                  cargo_dimensions: cargoFromPlaces.cargo_dimensions
              };
          })();

          const formData = new FormData();
          formData.append('templateId', selectedRequestTemplate.id);
          formData.append('values', JSON.stringify(valuesForSend));
          if (requestAttachment) {
              formData.append('file', requestAttachment);
          }

          const res = await fetch(`${API_URL}/requests/send`, {
              method: 'POST',
              body: formData
          });
          const data = await res.json();
          if (data.error) {
              throw new Error(data.error);
          }

          if (selectedRequestTemplate.code === 'warehouse_issue_request') {
              if (data.warehouseOrder && typeof data.warehouseOrder === 'object') {
                  setWarehouseOrders((prev) => {
                      const exists = prev.some((order) => Number(order.id) === Number(data.warehouseOrder.id));
                      return exists ? prev : [data.warehouseOrder, ...prev];
                  });
              } else {
                  await loadWarehouseOrders();
              }
          }

          clearRequestAttachment();
          setRequestFeedback({ type: 'success', text: 'Заяву успішно відправлено в чат.' });
      } catch (error) {
          console.error(error);
          setRequestFeedback({ type: 'error', text: error.message || 'Не вдалося відправити заяву.' });
      } finally {
          setRequestSending(false);
      }
  };

  const filteredDialogs = React.useMemo(() => {
      let filtered = dialogs;

      if (searchQuery) {
          filtered = filtered.filter(d => d.name.toLowerCase().includes(searchQuery.toLowerCase()));
      }

      let res = [];
      const currentFolder = activeFolderId === null ? 'main' : String(activeFolderId);

      if (activeFolderId === null) {
          res = filtered.filter(d => !d.archived);
      } else {
          const folder = folders.find(f => f.id === activeFolderId);
          if (!folder) {
              res = filtered.filter(d => !d.archived);
          } else {
              res = filtered.filter(d => {
                  if (folder.excludePeers && folder.excludePeers.includes(d.id)) return false;
                  if (folder.includePeers && folder.includePeers.includes(d.id)) return true;

                  if (folder.excludeMuted && d.isMuted) return false;
                  if (folder.excludeRead && d.unreadCount === 0) return false;
                  if (folder.excludeArchived && d.archived) return false;

                  if (folder.contacts && d.isContact && !d.isBot) return true;
                  if (folder.nonContacts && d.isUser && !d.isContact && !d.isBot) return true;
                  if (folder.groups && d.isGroup) return true;
                  if (folder.broadcasts && d.isChannel && !d.isGroup) return true;
                  if (folder.bots && d.isBot) return true;

                  return false;
              });
          }
      }

      return res.sort((a,b) => {
          const pinA = localPins.find(p => p.folder_id === currentFolder && String(p.chat_id) === String(a.id));
          const pinB = localPins.find(p => p.folder_id === currentFolder && String(p.chat_id) === String(b.id));

          if (pinA && pinB) return pinB.pinned_at - pinA.pinned_at;
          if (pinA && !pinB) return -1;
          if (!pinA && pinB) return 1;
          
          return b.date - a.date;
      });
  }, [dialogs, folders, activeFolderId, searchQuery, localPins]);

  useEffect(() => {
      localStorage.setItem('tgcrm-muted-notification-chat-ids', JSON.stringify(mutedNotificationChatIds));
  }, [mutedNotificationChatIds]);

  useEffect(() => {
      const handleClickOutside = (event) => {
          if (showNotificationCenter) {
              const clickedInsideBell = notificationCenterRef.current && notificationCenterRef.current.contains(event.target);
              const clickedInsidePanel = notificationPanelRef.current && notificationPanelRef.current.contains(event.target);
              if (!clickedInsideBell && !clickedInsidePanel) {
                  setShowNotificationCenter(false);
              }
          }
          if (showDirectNotificationCenter) {
              const clickedInsideBell = directNotificationCenterRef.current && directNotificationCenterRef.current.contains(event.target);
              const clickedInsidePanel = directNotificationPanelRef.current && directNotificationPanelRef.current.contains(event.target);
              if (!clickedInsideBell && !clickedInsidePanel) {
                  setShowDirectNotificationCenter(false);
              }
          }
      };
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNotificationCenter, showDirectNotificationCenter]);

  useEffect(() => {
      if (!showNotificationCenter) return;

      const updatePosition = () => {
          const bell = notificationBellButtonRef.current;
          if (!bell) return;
          const rect = bell.getBoundingClientRect();
          const viewportWidth = window.innerWidth || 1280;
          const panelWidth = Math.min(420, Math.floor(viewportWidth * 0.8), 380);
          const desiredLeft = rect.right + 8;
          const maxLeft = Math.max(8, viewportWidth - panelWidth - 8);
          setNotificationPanelPosition({
              top: Math.max(8, rect.top),
              left: Math.min(desiredLeft, maxLeft)
          });
      };

      updatePosition();
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
      return () => {
          window.removeEventListener('resize', updatePosition);
          window.removeEventListener('scroll', updatePosition, true);
      };
  }, [showNotificationCenter]);

  useEffect(() => {
      if (!showDirectNotificationCenter) return;

      const updatePosition = () => {
          const bell = directNotificationBellButtonRef.current;
          if (!bell) return;
          const rect = bell.getBoundingClientRect();
          const viewportWidth = window.innerWidth || 1280;
          const panelWidth = Math.min(420, Math.floor(viewportWidth * 0.8), 380);
          const desiredLeft = rect.right + 8;
          const maxLeft = Math.max(8, viewportWidth - panelWidth - 8);
          setDirectNotificationPanelPosition({
              top: Math.max(8, rect.top),
              left: Math.min(desiredLeft, maxLeft)
          });
      };

      updatePosition();
      window.addEventListener('resize', updatePosition);
      window.addEventListener('scroll', updatePosition, true);
      return () => {
          window.removeEventListener('resize', updatePosition);
          window.removeEventListener('scroll', updatePosition, true);
      };
  }, [showDirectNotificationCenter]);

  const isChatMutedForNotifications = (chatId) => mutedNotificationChatIds.includes(String(chatId));

  const dialogHasMentionInLastMessage = (dialog) => /(^|\s)@\w+/u.test(String(dialog?.lastMessage || ''));

  const shouldIncludeDialogInNotificationCenter = (dialog) => {
      if (!dialog || (dialog.unreadCount || 0) <= 0) return false;
      if (!isChatMutedForNotifications(dialog.id)) return true;
      return dialogHasMentionInLastMessage(dialog);
  };

  const notificationItems = React.useMemo(() => {
      return dialogs
          .filter(shouldIncludeDialogInNotificationCenter)
          .sort((a, b) => (b.date || 0) - (a.date || 0))
          .slice(0, 10);
  }, [dialogs, mutedNotificationChatIds]);

  const notificationUnreadTotal = React.useMemo(
      () => notificationItems.reduce((sum, dialog) => sum + Number(dialog.unreadCount || 0), 0),
      [notificationItems]
  );

  const directNotificationItems = React.useMemo(() => {
      return dialogs
          .filter((dialog) => Number(dialog?.unreadMentionsCount || 0) > 0)
          .sort((a, b) => (b.date || 0) - (a.date || 0))
          .slice(0, 15);
  }, [dialogs]);

  const directNotificationUnreadTotal = React.useMemo(
      () => directNotificationItems.reduce((sum, dialog) => sum + Number(dialog.unreadMentionsCount || 0), 0),
      [directNotificationItems]
  );

  const handleToggleNotificationMute = (chatId) => {
      const normalized = String(chatId);
      setMutedNotificationChatIds((prev) => (
          prev.includes(normalized)
              ? prev.filter((id) => id !== normalized)
              : [...prev, normalized]
      ));
  };

  const handleOpenNotificationItem = (dialog) => {
      setShowNotificationCenter(false);
      handleDialogClick(dialog);
      setActiveTab('messenger');
  };

  const handleOpenDirectNotificationItem = (dialog) => {
      setShowDirectNotificationCenter(false);
      handleDialogClick(dialog);
      setActiveTab('messenger');
  };

  const handleMarkAllNotificationsRead = () => {
      const ids = new Set(notificationItems.map((dialog) => String(dialog.id)));
      if (ids.size === 0) return;
      setDialogs((prev) => prev.map((dialog) => (
          ids.has(String(dialog.id)) ? { ...dialog, unreadCount: 0 } : dialog
      )));
      if (selectedDialog && ids.has(String(selectedDialog.id))) {
          setSelectedDialog((prev) => (prev ? { ...prev, unreadCount: 0 } : prev));
      }
      setShowNotificationCenter(false);
  };

  const handleMarkAllDirectNotificationsRead = () => {
      const ids = new Set(directNotificationItems.map((dialog) => String(dialog.id)));
      if (ids.size === 0) return;
      setDialogs((prev) => prev.map((dialog) => (
          ids.has(String(dialog.id))
              ? { ...dialog, unreadMentionsCount: 0, unreadCount: 0 }
              : dialog
      )));
      if (selectedDialog && ids.has(String(selectedDialog.id))) {
          setSelectedDialog((prev) => (
              prev ? { ...prev, unreadMentionsCount: 0, unreadCount: 0 } : prev
          ));
      }
      setShowDirectNotificationCenter(false);
  };

  const handleDialogClick = (dialog, options = {}) => {
      const dialogId = String(dialog.id);
      const requestId = dialogLoadRequestRef.current + 1;
      const focusMessageId = Number.isFinite(Number(options.focusMessageId)) ? Number(options.focusMessageId) : null;
      dialogLoadRequestRef.current = requestId;
      activeDialogIdRef.current = dialogId;
      pendingScrollTargetRef.current = focusMessageId ? String(focusMessageId) : 'bottom';

      abortPendingDialogFetches();
      setSelectedDialog({ ...dialog, unreadCount: 0, unreadMentionsCount: 0 });
      setDialogs(prev => prev.map(d => String(d.id) === String(dialog.id) ? { ...d, unreadCount: 0, unreadMentionsCount: 0 } : d));
      setLoadingMessages(true);
      setMessages([]); // Clear old messages
      setChatNoteText('');
      setParticipants([]); // Clear old participants
      setMentionQuery(null);
      setShowMentions(false);
      setMessageSelectMode(false);
      setSelectedMessageIds([]);
      setShowForwardModal(null);
      setHasMoreMessages(true);
      setLoadingOlderMessages(false);

      const messagesController = new AbortController();
      const noteController = new AbortController();
      dialogFetchControllersRef.current.messages = messagesController;
      dialogFetchControllersRef.current.note = noteController;
      const messagesQuery = focusMessageId ? { focusMessageId } : { limit: 120 };
      fetch(buildMessagesUrl(dialog.id, messagesQuery, dialog), { signal: messagesController.signal })
        .then(async (res) => {
            const data = await res.json();
            if (!res.ok) {
                const errorText = data?.error || `HTTP ${res.status}`;
                throw new Error(errorText);
            }
            return data;
        })
        .then(data => {
            if (dialogLoadRequestRef.current !== requestId || activeDialogIdRef.current !== dialogId) return;
            if (Array.isArray(data)) {
                setMessages(mergeMessagesForDialog(dialogId, data));
                if (!focusMessageId && data.length < 120) {
                    setHasMoreMessages(false);
                }
                return;
            }
            throw new Error('Невірний формат відповіді історії чату');
        })
        .catch(error => {
            if (error.name !== 'AbortError') {
                console.error(error);
            }
        })
        .finally(() => {
            if (activeDialogIdRef.current === dialogId) {
                setLoadingMessages(false);
            }
        });

      fetch(`${API_URL}/chat/${dialog.id}/note`, { signal: noteController.signal })
        .then(res => res.json())
        .then(data => {
            if (dialogLoadRequestRef.current === requestId && activeDialogIdRef.current === dialogId) {
                setChatNoteText(data.content || '');
            }
        })
        .catch(error => {
            if (error.name !== 'AbortError') {
                console.error(error);
            }
        });
        
      // Fetch participants for mentions (only for groups/channels)
      if (dialog.isGroup || dialog.isChannel) {
          const participantsController = new AbortController();
          dialogFetchControllersRef.current.participants = participantsController;

          fetch(`${API_URL}/chat/${dialog.id}/participants`, { signal: participantsController.signal })
            .then(res => res.json())
            .then(data => {
                if (
                    dialogLoadRequestRef.current === requestId &&
                    activeDialogIdRef.current === dialogId &&
                    Array.isArray(data)
                ) {
                    setParticipants(data);
                }
            })
            .catch(error => {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            });
      }
  };

  const handleSaveChatNote = async () => {
       try {
           const anchorMessageId = getCurrentCommentAnchorMessageId();
           await fetch(`${API_URL}/chat/${selectedDialog.id}/note`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ content: chatNoteText, anchorMessageId })
           });
           setShowChatNoteModal(false);
       } catch (e) {
           console.error(e);
       }
  };

  const handleDeleteChatNote = async (chatId) => {
      try {
          const res = await fetch(`${API_URL}/chat/${chatId}/note`, { method: 'DELETE' });
          const data = await res.json();
          if (!data.success) {
              throw new Error(data.error || 'Не вдалося видалити коментар');
          }

          setAllChatNotes(prev => prev.filter(note => String(note.chat_id) !== String(chatId)));
          if (selectedDialog && String(selectedDialog.id) === String(chatId)) {
              setChatNoteText('');
          }
      } catch (error) {
          console.error(error);
          alert('Помилка видалення коментаря');
      }
  };

  const handleForwardMessage = async (targetId) => {
       const messageIdsToForward = Array.isArray(showForwardModal?.messageIds)
           ? showForwardModal.messageIds
           : [];
       if (messageIdsToForward.length === 0) return;

       try {
           await fetch(`${API_URL}/chat/forward`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({ fromPeer: selectedDialog.id, toPeer: targetId, messageIds: messageIdsToForward.map(id => Number(id)) })
           });
           setShowForwardModal(null);
           setMessageSelectMode(false);
           setSelectedMessageIds([]);
       } catch (e) {
           console.error(e);
           alert("Помилка пересилання");
       }
  };

  const handleDeleteMessage = async (messageId) => {
      if (!window.confirm('Видалити повідомлення для всіх?')) return;
      try {
          const res = await fetch(`${API_URL}/chat/messages`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  peerId: selectedDialog.id,
                  messageIds: [messageId],
                  revoke: true
              })
          });
          const result = await res.json();
          if (result.success) {
              setMessages(prev => prev.filter(m => m.id !== messageId));
          } else {
              alert(result.error || 'Не вдалося видалити повідомлення');
          }
      } catch (e) {
          console.error(e);
          alert('Помилка видалення');
      }
  };

  const handleToggleMessageSelection = (messageId) => {
      const normalizedId = String(messageId);
      setSelectedMessageIds(prev => prev.includes(normalizedId)
          ? prev.filter(id => id !== normalizedId)
          : [...prev, normalizedId]
      );
  };

  const handleStartMessageSelection = () => {
      setMessageSelectMode(true);
      setSelectedMessageIds([]);
  };

  const handleCancelMessageSelection = () => {
      setMessageSelectMode(false);
      setSelectedMessageIds([]);
  };

  const handleForwardSelectedMessages = () => {
      if (selectedMessageIds.length === 0) {
          alert('Спочатку обери повідомлення');
          return;
      }
      setShowForwardModal({ messageIds: selectedMessageIds });
  };

  const handleDeleteSelectedMessages = async () => {
      if (selectedMessageIds.length === 0) {
          alert('Спочатку обери повідомлення');
          return;
      }
      if (!window.confirm(`Видалити ${selectedMessageIds.length} повідомлень для всіх?`)) return;
      try {
          const res = await fetch(`${API_URL}/chat/messages`, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  peerId: selectedDialog.id,
                  messageIds: selectedMessageIds.map(id => Number(id)),
                  revoke: true
              })
          });
          const result = await res.json();
          if (result.success) {
              setMessages(prev => prev.filter(m => !selectedMessageIds.includes(String(m.id))));
              setSelectedMessageIds([]);
              setMessageSelectMode(false);
          } else {
              alert(result.error || 'Не вдалося видалити повідомлення');
          }
      } catch (e) {
          console.error(e);
          alert('Помилка видалення');
      }
  };

  const handleChatFileDrop = (filesLike) => {
      addFilesToComposer(filesLike);
      setChatDropActive(false);
      focusComposer();
  };

  const handleSaveMessageNote = async () => {
       try {
           await fetch(`${API_URL}/notes/saved`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({
                   chatId: selectedDialog.id,
                   messageId: showSaveMessageModal.id,
                   messageText: showSaveMessageModal.text,
                   mediaPath: showSaveMessageModal.mediaPath,
                   comment: messageNoteComment
               })
           });
           setShowSaveMessageModal(null);
           setMessageNoteComment('');
       } catch (e) {
           console.error(e);
       }
  };

  const handleDeleteSavedMessage = async (id) => {
      try {
           await fetch(`${API_URL}/notes/saved/${id}`, { method: 'DELETE' });
           setSavedMessagesList(prev => prev.filter(m => m.id !== id));
      } catch (e) { console.error(e); }
  };

  const handleSaveFolder = async (folderObj) => {
      try {
          const res = await fetch(`${API_URL}/chat/folders`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(folderObj)
          });
          const data = await res.json();
          if (data.success) {
              fetch(`${API_URL}/chat/folders?v=${Date.now()}`, { cache: 'no-store' })
                .then(r => r.json())
                .then(d => { if (Array.isArray(d)) setFolders(d); });
              setSelectedFolderForManage(folderObj); // Update UI
          } else {
              alert("Помилка збереження: " + data.error);
          }
      } catch (e) { console.error(e); alert("Помилка збереження."); }
  };

  const handleDeleteFolder = async (id) => {
      if (!window.confirm("Дійсно видалити цю папку? Це також видалить її у вашому Telegram (але не видалить самі чати).")) return;
      try {
          const res = await fetch(`${API_URL}/chat/folders/${id}`, { method: 'DELETE' });
          const data = await res.json();
          if (data.success) {
              setFolders(prev => prev.filter(f => f.id !== id));
              if (selectedFolderForManage?.id === id) setSelectedFolderForManage(null);
          } else {
              alert("Помилка: " + data.error);
          }
      } catch(e) { console.error(e); }
  };

  const resetClientState = () => {
      try {
          localStorage.removeItem('tgcrm-tasks-v1');
          localStorage.removeItem('tgcrm-task-daily-notes-v1');
          localStorage.removeItem('tgcrm-task-reminder-settings-v1');
      } catch (_) {}

      setIsAuthenticated(false);
      setSelectedDialog(null);
      setDialogs([]);
      setMessages([]);
      setContacts([]);
      setParticipants([]);
      setTasks([]);
      setSelectedTaskId(null);
      setQuickTaskTitle('');
      setBulkTaskText('');
      setTaskDailyNotesByDate({});
      setTaskReminderSettings({ enabled: false, time: '09:00', chatId: '', lastSentDate: '' });
      setShowSettingsModal(false);
  };

  const handleLogout = async () => {
      if (!window.confirm('Вийти з Telegram на цьому ПК? Сесію буде збережено, ви зможете увійти знову без очищення даних.')) return;
      try {
          const res = await fetch(`${API_URL}/settings/logout`, { method: 'POST' });
          const data = await res.json();
          if (data.success) {
              resetClientState();
              alert('Ви вийшли з Telegram. Сесію збережено.');
          }
      } catch (e) {
          console.error(e);
          alert("Помилка при виході");
      }
  };

  const handleClearSession = async () => {
      if (!window.confirm('Очистити Telegram-сесію та локальні дані програми? Після цього потрібен повний повторний вхід.')) return;
      try {
          const res = await fetch(`${API_URL}/settings/session/clear`, { method: 'POST' });
          const data = await res.json();
          if (data.success) {
              resetClientState();
              alert('Сесію та локальні дані очищено. Увійдіть заново.');
          } else {
              alert(data?.error || 'Не вдалося очистити сесію.');
          }
      } catch (e) {
          console.error(e);
          alert('Помилка очищення сесії');
      }
  };

  const handleAppRefresh = () => {
      window.location.reload();
  };

  if (loading) {
    return (
        <div className="flex items-center justify-center h-screen w-screen bg-background">
            <div className="text-white">Завантаження...</div>
        </div>
    );
  }

  if (!apiConfigured) {
      return (
          <div className="min-h-screen bg-[#0b101e] flex flex-col items-center justify-center p-4 text-slate-200">
              <div className="bg-slate-900 border border-slate-700/50 p-8 rounded-3xl shadow-2xl max-w-md w-full relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-indigo-500"></div>
                  <h2 className="text-2xl font-bold mb-2 flex items-center justify-center gap-3">
                      <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      </svg>
                      Налаштування API
                  </h2>
                  <p className="text-slate-400 text-sm mb-6 text-center">Будь ласка, вкажіть ваші API ID та API Hash для запуску CRM. Ви можете взяти їх на <a href="https://my.telegram.org/" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">my.telegram.org</a>.</p>
                  
                  <div className="space-y-4 mb-6">
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API ID</label>
                          <input type="text" value={settingsApiId} onChange={e => setSettingsApiId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-200 outline-none focus:border-blue-500 transition" placeholder="Приклад: 123456" />
                      </div>
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API Hash</label>
                          <input type="text" value={settingsApiHash} onChange={e => setSettingsApiHash(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-slate-200 outline-none focus:border-blue-500 transition" placeholder="Приклад: e2a..." />
                      </div>
                      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                          <div className="flex items-center justify-between gap-3">
                              <div>
                                  <div className="text-xs font-semibold text-slate-300">Автозавантаження відео</div>
                                  <div className="text-[11px] text-slate-500 mt-1">Якщо вимкнути, відео завантажується вручну кнопкою в чаті.</div>
                              </div>
                              <button
                                  type="button"
                                  onClick={() => setAutoDownloadVideos((prev) => !prev)}
                                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${autoDownloadVideos ? 'bg-blue-600' : 'bg-slate-600'}`}
                              >
                                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${autoDownloadVideos ? 'translate-x-5' : 'translate-x-1'}`} />
                              </button>
                          </div>
                      </div>
                      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                          <div className="flex items-start justify-between gap-3">
                              <div>
                                  <div className="text-xs font-semibold text-slate-300">Локальне сховище</div>
                                  <div className="text-[11px] text-slate-500 mt-1">
                                      Медіа: {formatBytes(mediaStorageStats.mediaBytes)} | Аватари: {formatBytes(mediaStorageStats.avatarsBytes)}
                                  </div>
                                  <div className="text-sm text-slate-200 mt-1">Разом: {formatBytes(mediaStorageStats.totalBytes)}</div>
                              </div>
                              <button
                                  type="button"
                                  onClick={handleClearMediaStorage}
                                  disabled={clearingMediaStorage || loadingMediaStorage}
                                  className="px-3 py-2 text-xs rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-60 transition"
                              >
                                  {clearingMediaStorage ? 'Очищення...' : 'Видалити всі медіа'}
                              </button>
                          </div>
                      </div>
                  </div>

                  <button onClick={handleSaveSettings} className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-xl transition font-medium shadow-lg shadow-blue-900/20">
                      Зберегти та Запустити
                  </button>
              </div>
          </div>
      );
  }

  if (!isAuthenticated) {
    return <Auth onAuthenticated={() => setIsAuthenticated(true)} appTheme={appTheme} />;
  }

  const navLabelClass = (isNavCollapsed || isCompactLayout) ? 'hidden' : 'hidden md:block';
  const navJustifyClass = (isNavCollapsed || isCompactLayout) ? 'justify-center' : 'justify-center md:justify-start';
  const compactNavControls = isNavCollapsed || isCompactLayout;
  const todayTaskDate = getTodayDateValue();
  const tomorrowTaskDate = getTomorrowDateValue();
  const normalizedTaskSearch = taskSearch.trim().toLowerCase();
  const isTaskOverdue = (task) => !!task.dueDate && task.dueDate < todayTaskDate && task.status !== 'done';
  const filteredTasks = tasks.filter((task) => {
      const haystack = `${task.title || ''} ${task.description || ''} ${resolveTaskChatName(task.chatId)}`.toLowerCase();
      const matchesSearch = !normalizedTaskSearch || haystack.includes(normalizedTaskSearch);
      if (!matchesSearch) return false;
      if (taskFilter === 'today') return task.planDate === todayTaskDate;
      if (taskFilter === 'overdue') return isTaskOverdue(task);
      if (taskFilter === 'high') return task.priority === 'high';
      if (taskFilter === 'no_chat') return !task.chatId;
      return true;
  });
  const tasksByStatus = {
      plan: filteredTasks.filter((task) => task.status === 'plan'),
      in_progress: filteredTasks.filter((task) => task.status === 'in_progress'),
      done: filteredTasks.filter((task) => task.status === 'done')
  };
  const todayPlannerTasks = filteredTasks.filter((task) => task.planDate === todayTaskDate);
  const overdueTasks = filteredTasks.filter((task) => isTaskOverdue(task));
  const topFocusTasks = filteredTasks
      .filter((task) => task.status !== 'done')
      .sort((a, b) => {
          const priorityWeight = { high: 0, medium: 1, low: 2 };
          const pDiff = (priorityWeight[a.priority] ?? 1) - (priorityWeight[b.priority] ?? 1);
          if (pDiff !== 0) return pDiff;
          if ((a.dueDate || '') !== (b.dueDate || '')) return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
          return String(a.title || '').localeCompare(String(b.title || ''), 'uk');
      })
      .slice(0, 3);
  const movedToTomorrowTasks = tasks.filter((task) => task.planDate === tomorrowTaskDate && task.movedFromDate === todayTaskDate);
  const todayTaskNote = taskDailyNotesByDate[todayTaskDate] || '';
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
  const taskStatusMeta = {
      plan: { label: 'План', badge: 'bg-slate-700/70 text-slate-200 border-slate-600', dot: 'bg-slate-400' },
      in_progress: { label: 'В роботі', badge: 'bg-blue-500/20 text-blue-300 border-blue-500/30', dot: 'bg-blue-400' },
      done: { label: 'Готово', badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30', dot: 'bg-emerald-400' }
  };
  const orderStatusMeta = {
      new: { label: 'Нова', className: 'bg-slate-700/60 text-slate-200 border-slate-600' },
      in_progress: { label: 'В роботі', className: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
      ready: { label: 'Готово', className: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
      issued: { label: 'Видано', className: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' },
      rejected: { label: 'Відхилено', className: 'bg-red-500/20 text-red-300 border-red-500/30' }
  };
  const orderTypeMeta = {
      reservation: { label: 'Бронь', className: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
      issuance: { label: 'Видача', className: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' }
  };
  const filteredWarehouseOrders = warehouseOrders.filter((order) => {
      if (warehouseOrdersFilter === 'all') return true;
      return String(order.status || '') === warehouseOrdersFilter;
  });

  return (
    <div className="fixed inset-0 flex bg-background text-slate-200 overflow-hidden">
      {/* Sidebar Navigation */}
      <div className={`app-nav-sidebar glass shadow-2xl flex flex-col z-20 border-r border-slate-700/50 ${isNavCollapsed ? 'is-collapsed' : ''}`}>
        <div className={`${(isNavCollapsed || isCompactLayout) ? 'hidden' : 'hidden md:block'} p-4 border-b border-slate-700/50`}>
           <img src={appTheme === 'light' ? '/solar-logo-light.png' : '/solar-logo.png'} alt="Solar Service" className="h-12 w-auto object-contain" />
        </div>
        <div className="p-2 md:p-4 flex-1 min-h-0 overflow-y-auto">
            <div className={`flex items-start mb-3 ${(isNavCollapsed || isCompactLayout) ? 'justify-center' : 'justify-center md:justify-between'}`}>
                <div className={`${(isNavCollapsed || isCompactLayout) ? 'hidden' : 'hidden md:block'} text-sm font-semibold text-slate-400 uppercase tracking-wider`}>Навігація</div>
                <div className="relative" ref={(node) => { notificationCenterRef.current = node; directNotificationCenterRef.current = node; }}>
                    {!compactNavControls && (
                        <div className="hidden md:grid grid-cols-2 gap-2">
                            <button
                                onClick={() => setIsNavCollapsed((prev) => !prev)}
                                className="w-8 h-8 inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition border border-slate-700"
                                title={isNavCollapsed ? 'Розгорнути меню' : 'Згорнути меню'}
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isNavCollapsed ? 'M13 5l7 7-7 7M5 5v14' : 'M11 19l-7-7 7-7M19 5v14'} />
                                </svg>
                            </button>
                            <button
                                onClick={() => setAppTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
                                className="w-8 h-8 inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition border border-slate-700"
                                title={appTheme === 'dark' ? 'Світла тема' : 'Темна тема'}
                            >
                                {appTheme === 'dark' ? (
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v2.2m0 13.6V21m9-9h-2.2M5.2 12H3m14.6 6.6l-1.6-1.6M8 8l-1.6-1.6m11.2 0L16 8M8 16l-1.6 1.6M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    </svg>
                                ) : (
                                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20.354 15.354A9 9 0 018.646 3.646 9 9 0 1012 21a8.96 8.96 0 008.354-5.646z" />
                                    </svg>
                                )}
                            </button>
                            <button
                                ref={notificationBellButtonRef}
                                onClick={() => {
                                    setShowDirectNotificationCenter(false);
                                    setShowNotificationCenter((prev) => !prev);
                                }}
                                className="relative w-8 h-8 inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition border border-slate-700"
                                title="Сповіщення"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.17V11a6 6 0 10-12 0v3.17a2 2 0 01-.6 1.43L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                                </svg>
                                {notificationUnreadTotal > 0 && (
                                    <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
                                        {notificationUnreadTotal > 99 ? '99+' : notificationUnreadTotal}
                                    </span>
                                )}
                            </button>
                            <button
                                ref={directNotificationBellButtonRef}
                                onClick={() => {
                                    setShowNotificationCenter(false);
                                    setShowDirectNotificationCenter((prev) => !prev);
                                }}
                                className="relative w-8 h-8 inline-flex items-center justify-center bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition border border-slate-700"
                                title="Відповіді та згадки"
                            >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 8h10M7 12h7m-7 4h5m8-10a2 2 0 00-2-2H6a2 2 0 00-2 2v12l4-3h10a2 2 0 002-2V6z" />
                                </svg>
                                {directNotificationUnreadTotal > 0 && (
                                    <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-slate-950 text-[9px] font-semibold flex items-center justify-center">
                                        {directNotificationUnreadTotal > 99 ? '99+' : directNotificationUnreadTotal}
                                    </span>
                                )}
                            </button>
                        </div>
                    )}
                </div>
            </div>
            {compactNavControls && (
                <div className="mb-3 flex flex-col gap-2">
                    <button
                        onClick={() => setIsNavCollapsed((prev) => !prev)}
                        className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-300`}
                        data-tooltip={isNavCollapsed ? 'Розгорнути меню' : 'Згорнути меню'}
                    >
                        <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={isNavCollapsed ? 'M13 5l7 7-7 7M5 5v14' : 'M11 19l-7-7 7-7M19 5v14'} />
                        </svg>
                        <span className={navLabelClass}>{isNavCollapsed ? 'Розгорнути меню' : 'Згорнути меню'}</span>
                    </button>
                    <button
                        ref={notificationBellButtonRef}
                        onClick={() => {
                            setShowDirectNotificationCenter(false);
                            setShowNotificationCenter((prev) => !prev);
                        }}
                        className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-300`}
                        data-tooltip="Сповіщення"
                    >
                        <div className="relative">
                            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.4-1.4A2 2 0 0118 14.17V11a6 6 0 10-12 0v3.17a2 2 0 01-.6 1.43L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                            </svg>
                            {notificationUnreadTotal > 0 && (
                                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-red-500 text-white text-[9px] font-semibold flex items-center justify-center">
                                    {notificationUnreadTotal > 99 ? '99+' : notificationUnreadTotal}
                                </span>
                            )}
                        </div>
                        <span className={navLabelClass}>Сповіщення</span>
                    </button>
                    <button
                        ref={directNotificationBellButtonRef}
                        onClick={() => {
                            setShowNotificationCenter(false);
                            setShowDirectNotificationCenter((prev) => !prev);
                        }}
                        className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-300`}
                        data-tooltip="Відповіді/згадки"
                    >
                        <div className="relative">
                            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 8h10M7 12h7m-7 4h5m8-10a2 2 0 00-2-2H6a2 2 0 00-2 2v12l4-3h10a2 2 0 002-2V6z" />
                            </svg>
                            {directNotificationUnreadTotal > 0 && (
                                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-slate-950 text-[9px] font-semibold flex items-center justify-center">
                                    {directNotificationUnreadTotal > 99 ? '99+' : directNotificationUnreadTotal}
                                </span>
                            )}
                        </div>
                        <span className={navLabelClass}>Згадки/відповіді</span>
                    </button>
                    <button
                        onClick={() => setAppTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
                        className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-300`}
                        data-tooltip={appTheme === 'dark' ? 'Світла тема' : 'Темна тема'}
                    >
                        {appTheme === 'dark' ? (
                            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 3v2.2m0 13.6V21m9-9h-2.2M5.2 12H3m14.6 6.6l-1.6-1.6M8 8l-1.6-1.6m11.2 0L16 8M8 16l-1.6 1.6M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        ) : (
                            <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M20.354 15.354A9 9 0 018.646 3.646 9 9 0 1012 21a8.96 8.96 0 008.354-5.646z" />
                            </svg>
                        )}
                        <span className={navLabelClass}>{appTheme === 'dark' ? 'Світла тема' : 'Темна тема'}</span>
                    </button>
                </div>
            )}
            <div className="flex flex-col gap-2">
                <button onClick={() => setActiveTab('messenger')} data-tooltip="Месенджер" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'messenger' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <span className={navLabelClass}>Месенджер</span>
                </button>
                <button onClick={() => setActiveTab('crm')} data-tooltip="База CRM" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'crm' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    <span className={navLabelClass}>База CRM</span>
                </button>
                <button onClick={() => setActiveTab('bulk')} data-tooltip="Розсилки" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'bulk' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
                    </svg>
                    <span className={navLabelClass}>Розсилки</span>
                </button>
                <button onClick={() => setActiveTab('requests')} data-tooltip="Заяви" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'requests' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className={navLabelClass}>Заяви</span>
                </button>
                <button onClick={() => setActiveTab('warehouseOrders')} data-tooltip="Замовлення (Склад)" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'warehouseOrders' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4m-18 5l9 4 9-4" />
                    </svg>
                    <span className={navLabelClass}>Замовлення (Склад)</span>
                </button>
                <button onClick={() => setActiveTab('documentTemplates')} data-tooltip="Шаблони документів" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'documentTemplates' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h10M7 11h10M7 15h6m5 6H6a2 2 0 01-2-2V5a2 2 0 012-2h8l6 6v10a2 2 0 01-2 2z" />
                    </svg>
                    <span className={navLabelClass}>Шаблони документів</span>
                </button>
                {isSystemAdmin && (
                <button onClick={() => setActiveTab('adminUsers')} data-tooltip="Користувачі" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'adminUsers' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5V4H2v16h5m10 0v-2a4 4 0 00-4-4H11a4 4 0 00-4 4v2m10 0H7m8-10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
                    <span className={navLabelClass}>Користувачі</span>
                </button>
                )}
                <button onClick={() => setActiveTab('tasks')} data-tooltip="Задачі" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'tasks' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5h10M9 12h10M9 19h10M4 6h.01M4 12h.01M4 18h.01" />
                    </svg>
                    <span className={navLabelClass}>Задачі</span>
                </button>
                <button onClick={() => setActiveTab('tagsManager')} data-tooltip="Теги" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'tagsManager' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                    <span className={navLabelClass}>Теги</span>
                </button>
                <button onClick={() => setActiveTab('savedNotes')} data-tooltip="Нотатки" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'savedNotes' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                    <span className={navLabelClass}>Нотатки</span>
                </button>
                <button onClick={() => setActiveTab('comments')} data-tooltip="Коментарі" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'comments' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                    </svg>
                    <span className={navLabelClass}>Коментарі</span>
                </button>
                <button onClick={() => setActiveTab('foldersManager')} data-tooltip="Папки" className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 ${activeTab === 'foldersManager' ? 'bg-blue-500/20 text-blue-400' : 'hover:bg-slate-800 text-slate-300'}`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span className={navLabelClass}>Папки</span>
                </button>
            </div>
            
            <div className="mt-auto pt-4 flex flex-col gap-2">
                <button onClick={() => {
                    fetch(`${API_URL}/settings/telegram`).then(r=>r.json()).then(d=>{
                        setSettingsApiId(d.apiId || '');
                        setSettingsApiHash(''); // do not show hash fully
                        loadMediaStorageStats();
                        setShowSettingsModal(true);
                    }).catch(console.error);
                }} className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-400 hover:text-slate-200`}>
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span className={`${navLabelClass} text-sm`}>Налаштування API</span>
                </button>
                <button
                    onClick={handleAppRefresh}
                    className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-slate-800 text-slate-400 hover:text-slate-200`}
                    data-tooltip="Оновити інтерфейс (як F5)"
                >
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.2-3M4 15a8 8 0 0014.2 3" />
                    </svg>
                    <span className={`${navLabelClass} text-sm`}>Оновити (F5)</span>
                </button>
                <button
                    onClick={handleLogout}
                    className={`text-left px-3 py-3 rounded-xl transition font-medium flex items-center ${navJustifyClass} gap-3 hover:bg-red-600/20 text-red-400 hover:text-red-300`}
                    data-tooltip="Вийти з Telegram"
                >
                    <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M17 16l4-4m0 0l-4-4m4 4H9m4 4v1a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h5a2 2 0 012 2v1" />
                    </svg>
                    <span className={`${navLabelClass} text-sm`}>Вийти з Telegram</span>
                </button>
            </div>
        </div>
      </div>

      {showNotificationCenter && (
          <div
              ref={notificationPanelRef}
              className="notification-panel fixed w-[380px] max-w-[80vw] rounded-xl border border-slate-600 shadow-2xl z-[2147483000] overflow-hidden"
              style={{
                  top: `${notificationPanelPosition.top}px`,
                  left: `${notificationPanelPosition.left}px`,
              }}
          >
              <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between" style={{ backgroundColor: '#0f172a' }}>
                  <div className="text-sm font-semibold text-slate-100">Сповіщення</div>
                  <button
                      onClick={handleMarkAllNotificationsRead}
                      className="text-xs text-blue-300 hover:text-blue-200 transition"
                  >
                      Позначити всі як прочитані
                  </button>
              </div>
              <div className="notification-panel-list max-h-[420px]" style={{ backgroundColor: '#0b1220' }}>
                  {notificationItems.length === 0 ? (
                      <div className="px-4 py-8 text-sm text-slate-400 text-center">Нових важливих повідомлень немає</div>
                  ) : (
                      notificationItems.map((dialog) => (
                          <button
                              key={dialog.id}
                              onClick={() => handleOpenNotificationItem(dialog)}
                              className="notification-panel-item w-full min-w-0 text-left px-4 py-3 border-b border-slate-800 hover:bg-slate-800 transition"
                              style={{ backgroundColor: '#0b1220' }}
                          >
                              <div className="flex items-start gap-3">
                                  <div className="w-9 h-9 rounded-full bg-slate-700 text-slate-200 font-semibold flex items-center justify-center overflow-hidden shrink-0">
                                      {dialog.avatarPath ? (
                                          <img src={buildUploadUrl(dialog.avatarPath)} className="w-full h-full object-cover" alt={dialog.name} />
                                      ) : (
                                          dialog.name.charAt(0)
                                      )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-2">
                                          <div className="text-sm text-slate-100 font-medium truncate">{dialog.name}</div>
                                          <div className="min-w-[22px] h-5 px-1.5 rounded-full bg-blue-500 text-white text-[11px] font-semibold flex items-center justify-center shrink-0">
                                              {dialog.unreadCount}
                                          </div>
                                      </div>
                                      <div className="text-xs text-slate-300 truncate mt-1">{dialog.lastMessage || 'Нове повідомлення'}</div>
                                  </div>
                              </div>
                          </button>
                      ))
                  )}
              </div>
          </div>
      )}

      {showDirectNotificationCenter && (
          <div
              ref={directNotificationPanelRef}
              className="notification-panel fixed w-[380px] max-w-[80vw] rounded-xl border border-slate-600 shadow-2xl z-[2147483000] overflow-hidden"
              style={{
                  top: `${directNotificationPanelPosition.top}px`,
                  left: `${directNotificationPanelPosition.left}px`,
              }}
          >
              <div className="px-4 py-3 border-b border-slate-700 flex items-center justify-between" style={{ backgroundColor: '#0f172a' }}>
                  <div className="text-sm font-semibold text-slate-100">Згадки та відповіді</div>
                  <button onClick={handleMarkAllDirectNotificationsRead} className="text-xs text-blue-300 hover:text-blue-200 transition">
                      Позначити всі як прочитані
                  </button>
              </div>
              <div className="notification-panel-list max-h-[420px]" style={{ backgroundColor: '#0b1220' }}>
                  {directNotificationItems.length === 0 ? (
                      <div className="px-4 py-8 text-sm text-slate-400 text-center">Нових згадок або відповідей немає</div>
                  ) : (
                      directNotificationItems.map((dialog) => (
                          <button
                              key={`direct-${dialog.id}`}
                              onClick={() => handleOpenDirectNotificationItem(dialog)}
                              className="notification-panel-item w-full min-w-0 text-left px-4 py-3 border-b border-slate-800 hover:bg-slate-800 transition"
                              style={{ backgroundColor: '#0b1220' }}
                          >
                              <div className="flex items-start gap-3">
                                  <div className="w-9 h-9 rounded-full bg-slate-700 text-slate-200 font-semibold flex items-center justify-center overflow-hidden shrink-0">
                                      {dialog.avatarPath ? <img src={buildUploadUrl(dialog.avatarPath)} className="w-full h-full object-cover" alt={dialog.name} /> : dialog.name.charAt(0)}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-2">
                                          <div className="text-sm text-slate-100 font-medium truncate">{dialog.name}</div>
                                          <div className="min-w-[22px] h-5 px-1.5 rounded-full bg-amber-500 text-slate-950 text-[11px] font-semibold flex items-center justify-center shrink-0">
                                              {dialog.unreadMentionsCount}
                                          </div>
                                      </div>
                                      <div className="text-xs text-slate-300 truncate mt-1">{dialog.lastMessage || 'Нове повідомлення'}</div>
                                  </div>
                              </div>
                          </button>
                      ))
                  )}
              </div>
          </div>
      )}

      {/* Dialogs List */}
      {activeTab === 'messenger' && (
      <div className="app-dialogs-sidebar bg-slate-900 border-r border-slate-700/50 flex flex-col z-10 min-h-0">
          <div className="p-4 border-b border-slate-700/50 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10 flex flex-col gap-3 shrink-0">
              <div className="flex gap-2 items-center">
                  <input 
                      type="text" 
                      placeholder="Пошук..." 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="flex-1 bg-slate-800 text-sm border border-slate-700 rounded-lg px-3 py-2 outline-none focus:border-blue-500 transition"
                  />
                  <button
                      onClick={handleAppRefresh}
                      className="p-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition shadow-lg shadow-slate-700/30"
                      title="Оновити (F5)"
                  >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 00-14.2-3M4 15a8 8 0 0014.2 3" />
                      </svg>
                  </button>
                  <button 
                      onClick={() => setShowCreateGroupModal(true)}
                      className="p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition shadow-lg shadow-blue-500/20"
                      title="Створити групу"
                  >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                  </button>
              </div>
              {/* Folders Tab */}
              <div className="folders-strip flex gap-2 overflow-x-auto overflow-y-hidden pb-1">
                  <button 
                      onClick={() => setActiveFolderId(null)}
                      className={`whitespace-nowrap px-3 py-1.5 rounded-full text-[11px] font-medium transition ${activeFolderId === null ? 'bg-blue-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                  >
                      Всі чати
                  </button>
                  {folders.map(folder => (
                      <button 
                          key={folder.id}
                          onClick={() => setActiveFolderId(folder.id)}
                          className={`whitespace-nowrap flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-medium transition ${activeFolderId === folder.id ? 'bg-blue-600 text-white shadow-md' : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-700/50'}`}
                      >
                          {folder.emoticon && <span className="text-[14px] leading-none">{folder.emoticon}</span>}
                          {folder.title}
                      </button>
                  ))}
              </div>
          </div>
          <div className="dialogs-list flex-1 overflow-y-auto overflow-x-hidden min-h-0">
              {loadingDialogs && <div className="p-4 text-center text-slate-500 text-sm">Завантаження чатів...</div>}
              {filteredDialogs.map(dialog => (
                  <div 
                      key={dialog.id} 
                      onClick={() => handleDialogClick(dialog)}
                      className={`p-3 border-b border-slate-800/50 cursor-pointer transition flex items-center gap-3 ${selectedDialog?.id === dialog.id ? 'bg-blue-600/20 shadow-inner' : 'hover:bg-slate-800/50'}`}
                  >
                      <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 flex-shrink-0 flex items-center justify-center font-bold text-white text-lg overflow-hidden">
                          {dialog.avatarPath ? (
                              <img src={buildUploadUrl(dialog.avatarPath)} className="w-full h-full object-cover" alt="avatar" />
                          ) : (
                              dialog.name.charAt(0)
                          )}
                      </div>
                      <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center mb-1">
                              <h4 className="font-semibold text-slate-200 truncate pr-2">{dialog.name}</h4>
                          </div>
                          <div className="flex items-center gap-1 mb-1 overflow-x-hidden">
                              {assignments.filter(a => a.chat_id === String(dialog.id)).slice(0, 3).map(a => {
                                  const t = tags.find(x => x.id === a.tag_id);
                                  return t ? (
                                      <div 
                                          key={t.id} 
                                          data-tooltip={t.name}
                                          className="w-2 h-2 rounded-full cursor-help hover:scale-125 transition-transform" 
                                          style={{backgroundColor: t.color}}
                                      ></div>
                                  ) : null;
                              })}
                              {assignments.filter(a => a.chat_id === String(dialog.id)).length > 3 && (
                                  <span className="text-[8px] text-slate-500">+{assignments.filter(a => a.chat_id === String(dialog.id)).length - 3}</span>
                              )}
                          </div>
                          <p className="text-sm text-slate-400 truncate">{dialog.lastMessage}</p>
                      </div>
                      {isChatMutedForNotifications(dialog.id) && (
                          <div className="text-[10px] text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded-full px-1.5 py-0.5 shrink-0" data-tooltip="Чат приглушено в центрі сповіщень">
                              mute
                          </div>
                      )}
                      {dialog.unreadCount > 0 && (
                          <div className="bg-blue-500 text-white text-xs font-bold px-2 py-1 rounded-full">{dialog.unreadCount}</div>
                      )}
                  </div>
              ))}
          </div>
      </div>
      )}

      {/* Main Chat Area */}
      {activeTab === 'messenger' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative min-w-0 min-h-0 overflow-x-hidden">
          {!selectedDialog ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center opacity-50">
                  <div className="w-24 h-24 bg-slate-800 rounded-full flex items-center justify-center mb-4 shadow-xl">
                     <svg className="w-12 h-12 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
                     </svg>
                  </div>
                  <h3 className="text-xl font-medium text-slate-300">Оберіть чат</h3>
                  <p className="text-slate-500 text-sm mt-2">Виберіть діалог зліва для початку спілкування</p>
              </div>
          ) : (
              // Chat Interface
              <div
                  className="flex-1 flex flex-col min-h-0 relative overflow-x-hidden"
                  onDragEnter={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer?.types?.includes('Files')) {
                          setChatDropActive(true);
                      }
                  }}
                  onDragOver={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer?.types?.includes('Files')) {
                          setChatDropActive(true);
                      }
                  }}
                  onDragLeave={(e) => {
                      e.preventDefault();
                      if (e.currentTarget === e.target) {
                          setChatDropActive(false);
                      }
                  }}
                  onDrop={(e) => {
                      e.preventDefault();
                      setChatDropActive(false);
                      handleChatFileDrop(e.dataTransfer?.files || []);
                  }}
              >
                  {chatDropActive && (
                      <div className="absolute inset-0 z-[120] bg-blue-500/10 backdrop-blur-[1px] border-2 border-dashed border-blue-400 rounded-2xl flex items-center justify-center pointer-events-none">
                          <div className="px-6 py-4 rounded-2xl bg-slate-900/90 border border-blue-400/40 text-center shadow-2xl">
                              <div className="text-base font-semibold text-blue-300">Перетягни файл сюди</div>
                              <div className="text-sm text-slate-300 mt-1">Фото або документ буде додано до повідомлення</div>
                          </div>
                      </div>
                  )}
                  {/* Chat Header */}
                  <div className="relative z-[90] overflow-visible border-b border-slate-700/50 bg-slate-900/50 backdrop-blur-md px-4 pt-4 pb-3 md:px-6 shrink-0">
                      <div className="chat-header-main">
                      <div className="chat-header-info flex items-start gap-3 md:gap-4 min-w-0 flex-1">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 flex items-center justify-center font-bold text-white text-sm overflow-hidden shrink-0">
                          {selectedDialog.avatarPath ? (
                              <img src={buildUploadUrl(selectedDialog.avatarPath)} className="w-full h-full object-cover" alt="avatar" />
                          ) : (
                              selectedDialog.name.charAt(0)
                          )}
                      </div>
                      <div className="min-w-0 flex-1">
                          <h2 className="font-semibold text-slate-200 truncate">{selectedDialog.name}</h2>
                          <div className="flex flex-wrap items-center gap-2 mt-0.5">
                              <span className="text-xs text-slate-400 shrink-0">Telegram {selectedDialog.isGroup ? 'Group' : selectedDialog.isChannel ? 'Channel' : 'User'}</span>
                              <div className="flex flex-wrap gap-1 min-w-0">
                                  {assignments.filter(a => a.chat_id === String(selectedDialog.id)).map(a => {
                                      const t = tags.find(x => x.id === a.tag_id);
                                      return t ? <span key={t.id} style={{backgroundColor: t.color}} className="text-[10px] text-white px-2 py-0.5 rounded-full max-w-[140px] truncate">{t.name}</span> : null;
                                  })}
                                  <button onClick={() => setTagModalUserId(selectedDialog.id)} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full transition border border-slate-700 shrink-0">
                                      + Додати Тег
                                  </button>
                                  <button onClick={() => setShowChatNoteModal(true)} className={`text-[10px] px-2 py-0.5 rounded-full transition border flex gap-1 items-center shrink-0 ${hasChatNote ? 'bg-amber-500/15 text-amber-300 border-amber-500/30 hover:bg-amber-500/20' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'}`}>
                                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                      Коментарі
                                      {hasChatNote && <span className="w-1.5 h-1.5 rounded-full bg-amber-300"></span>}
                                  </button>
                                  {!selectedDialog.isGroup && !selectedDialog.isChannel && (
                                      <button
                                          onClick={() => handleOpenContactProfile({
                                              id: selectedDialog.id,
                                              firstName: selectedDialog.name,
                                              lastName: '',
                                              username: '',
                                              phone: ''
                                          })}
                                          className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full transition border border-slate-700 flex gap-1 items-center shrink-0"
                                      >
                                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                          </svg>
                                          Профіль
                                      </button>
                                  )}
                                  <button
                                      onClick={handleCreateTaskFromCurrentChat}
                                      className="text-[10px] bg-blue-600/15 hover:bg-blue-600/25 text-blue-300 px-2 py-0.5 rounded-full transition border border-blue-500/30 flex gap-1 items-center shrink-0"
                                  >
                                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5h10M9 12h10M9 19h10M4 6h.01M4 12h.01M4 18h.01" />
                                      </svg>
                                      У задачі
                                  </button>
                              </div>
                          </div>
                          {hasChatNote && (
                              <button
                                  onClick={() => setShowChatNoteModal(true)}
                                  className="mt-2 max-w-2xl text-left rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 hover:bg-amber-500/15 transition"
                              >
                                  <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">Коментар</div>
                                  <div className="text-sm text-slate-200 truncate">
                                      {chatNotePreview}
                                      {chatNoteText.trim().length > 110 ? '...' : ''}
                                  </div>
                              </button>
                          )}
                      </div>
                      </div>
                      <div className="chat-header-actions">
                          <button 
                              onClick={fetchPinnedMessages}
                              className="action-optional text-xs px-3 py-1.5 rounded-lg transition font-medium border bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200 hover:bg-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                              title="Закріплені повідомлення"
                          >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v8M5 10h14M19 10v1a3 3 0 01-3 3H8a3 3 0 01-3-3v-1M12 14v8" />
                              </svg>
                              <span className="action-label-full">Закріплені</span>
                              <span className="action-label-short">Закр.</span>
                          </button>
                          {selectedDialog.isGroup && (
                              <button 
                                  onClick={() => setShowAddMemberModal(true)}
                                  className="text-xs px-3 py-1.5 rounded-lg transition font-medium border bg-blue-600/20 text-blue-400 border-blue-500/30 hover:bg-blue-600/30 flex items-center gap-1 whitespace-nowrap shrink-0"
                              >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                                  </svg>
                                  <span className="action-label-full">+ Учасник</span>
                                  <span className="action-label-short">+ Учасн.</span>
                              </button>
                          )}
                          {selectedDialog.isGroup && (
                              <button 
                                  onClick={() => {
                                      setManageMemberSearchQuery('');
                                      setShowManageMembersModal(true);
                                  }}
                                  className="text-xs px-3 py-1.5 rounded-lg transition font-medium border bg-slate-800 text-slate-300 border-slate-700 hover:text-white hover:bg-slate-700 flex items-center gap-1 whitespace-nowrap shrink-0"
                              >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5V4H2v16h5m10 0v-2a4 4 0 00-4-4H11a4 4 0 00-4 4v2m10 0H7m5-10a4 4 0 100-8 4 4 0 000 8z" />
                                  </svg>
                                  <span className="action-label-full">Учасники</span>
                                  <span className="action-label-short">Учасн.</span>
                              </button>
                          )}
                          <button 
                              onClick={() => handleTogglePin(selectedDialog.id, !!localPins.find(p => p.folder_id === (activeFolderId === null ? 'main' : String(activeFolderId)) && String(p.chat_id) === String(selectedDialog.id)))}
                              className={`text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 flex items-center gap-1 whitespace-nowrap ${localPins.find(p => p.folder_id === (activeFolderId === null ? 'main' : String(activeFolderId)) && String(p.chat_id) === String(selectedDialog.id)) ? 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30 hover:bg-yellow-500/30' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200 hover:bg-slate-700'}`}
                          >
                              <svg className="w-3.5 h-3.5" fill={localPins.find(p => p.folder_id === (activeFolderId === null ? 'main' : String(activeFolderId)) && String(p.chat_id) === String(selectedDialog.id)) ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                              </svg>
                              <span className="action-label-full">{localPins.find(p => p.folder_id === (activeFolderId === null ? 'main' : String(activeFolderId)) && String(p.chat_id) === String(selectedDialog.id)) ? 'Відкріпити' : 'Закріпити'}</span>
                              <span className="action-label-short">{localPins.find(p => p.folder_id === (activeFolderId === null ? 'main' : String(activeFolderId)) && String(p.chat_id) === String(selectedDialog.id)) ? 'Відкр.' : 'Закр.'}</span>
                          </button>
                          <button
                              onClick={() => handleToggleNotificationMute(selectedDialog.id)}
                              className={`text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap ${isChatMutedForNotifications(selectedDialog.id) ? 'bg-amber-500/20 text-amber-300 border-amber-500/30 hover:bg-amber-500/30' : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200 hover:bg-slate-700'}`}
                              title="Повідомлення з цього чату не потраплятимуть у дзвоник, крім @згадок"
                          >
                              <span className="action-label-full">{isChatMutedForNotifications(selectedDialog.id) ? 'Не сповіщати: Увімк.' : 'Не сповіщати'}</span>
                              <span className="action-label-short">{isChatMutedForNotifications(selectedDialog.id) ? 'Мут: Вкл.' : 'Мут'}</span>
                          </button>
                          {!messageSelectMode ? (
                              <button
                                  onClick={handleStartMessageSelection}
                                  className="text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                              >
                                  <span className="action-label-full">Вибрати повідомлення</span>
                                  <span className="action-label-short">Вибрати</span>
                              </button>
                          ) : (
                              <>
                                  <span className="text-xs px-3 py-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 shrink-0 whitespace-nowrap">
                                      <span className="action-label-full">Обрано: {selectedMessageIds.length}</span>
                                      <span className="action-label-short">Обрано: {selectedMessageIds.length}</span>
                                  </span>
                                  <button
                                      onClick={handleForwardSelectedMessages}
                                      className="text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                                  >
                                      <span className="action-label-full">Переслати</span>
                                      <span className="action-label-short">Пересл.</span>
                                  </button>
                                  <button
                                      onClick={handleDeleteSelectedMessages}
                                      className="text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap bg-red-500/10 text-red-300 border-red-500/20 hover:bg-red-500/20"
                                  >
                                      <span className="action-label-full">Видалити</span>
                                      <span className="action-label-short">Видал.</span>
                                  </button>
                                  <button
                                      onClick={handleCancelMessageSelection}
                                      className="text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
                                  >
                                      <span className="action-label-full">Скасувати</span>
                                      <span className="action-label-short">Скас.</span>
                                  </button>
                              </>
                          )}
                          <button
                              onClick={selectedDialog.isGroup ? handleDeleteCurrentGroup : handleDeleteCurrentDialog}
                              className="text-xs px-3 py-1.5 rounded-lg transition font-medium border shrink-0 whitespace-nowrap bg-red-500/10 text-red-300 border-red-500/20 hover:bg-red-500/20"
                          >
                              <span className="action-label-full">{selectedDialog.isGroup ? 'Видалити групу' : 'Видалити діалог'}</span>
                              <span className="action-label-short">{selectedDialog.isGroup ? 'Видал. групу' : 'Видал. діалог'}</span>
                          </button>
                      </div>
                      </div>
                  </div>

                  {/* Messages Feed */}
                  <div className="messages-feed flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 space-y-4" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
                      {loadingMessages && <div className="text-center py-4 text-slate-400 text-sm animate-pulse">Завантаження історії...</div>}
                      {!loadingMessages && loadingOlderMessages && (
                          <div className="text-center py-2 text-slate-500 text-xs animate-pulse">Підвантажуємо старі повідомлення...</div>
                      )}
                      
                      {messages.map((msg, idx) => {
                          const replyTarget = msg.replyTo ? messagesById.get(String(msg.replyTo)) : null;
                          const incomingAvatarPath = msg.senderAvatarPath || (!selectedDialog.isGroup && !selectedDialog.isChannel ? selectedDialog.avatarPath : null);
                          const incomingAvatarFallback = (msg.senderName || selectedDialog.name || '?').charAt(0);
                          const isSelected = selectedMessageIds.includes(String(msg.id));
                          return (
                          <div key={msg.id || idx} ref={element => setMessageElementRef(msg.id, element)} data-message-id={msg.id} className={`flex items-end gap-3 ${msg.out ? 'justify-end' : 'justify-start'}`}>
                              {!msg.out && (
                                  <div className="w-9 h-9 rounded-full overflow-hidden bg-slate-700 text-slate-200 shrink-0 flex items-center justify-center text-xs font-semibold border border-slate-600/60">
                                      {incomingAvatarPath ? (
                                          <img src={buildUploadUrl(incomingAvatarPath)} className="w-full h-full object-cover" alt={msg.senderName || selectedDialog.name || 'avatar'} />
                                      ) : (
                                          incomingAvatarFallback
                                      )}
                                  </div>
                              )}
                              <div
                                  onClick={() => {
                                      if (messageSelectMode) {
                                          handleToggleMessageSelection(msg.id);
                                      }
                                  }}
                                  onDoubleClick={() => {
                                      if (msg.out) {
                                          handleStartEdit(msg);
                                      }
                                  }}
                                  className={`max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-2 text-[15px] relative group transition-all duration-300 ${msg.out ? 'bg-blue-600 text-white rounded-br-sm shadow-lg shadow-blue-900/20' : 'bg-slate-800 text-slate-200 rounded-bl-sm border border-slate-700/50'} ${isSelected ? 'ring-2 ring-amber-400' : ''} ${highlightedMessageId === String(msg.id) ? 'ring-2 ring-cyan-300 shadow-[0_0_0_3px_rgba(34,211,238,0.18)]' : ''} ${messageSelectMode ? 'cursor-pointer' : ''}`}
                              >
                                  {messageSelectMode && (
                                      <button
                                          type="button"
                                          onClick={(e) => {
                                              e.stopPropagation();
                                              handleToggleMessageSelection(msg.id);
                                          }}
                                          className={`absolute -top-2 ${msg.out ? '-left-2' : '-right-2'} w-5 h-5 rounded-full border text-[10px] flex items-center justify-center ${isSelected ? 'bg-amber-500 border-amber-300 text-slate-900' : 'bg-slate-900 border-slate-500 text-slate-300'}`}
                                      >
                                          {isSelected ? '✓' : ''}
                                      </button>
                                  )}
                                   {/* Action Buttons */}
                                  <div className={`absolute top-2 ${msg.out ? 'right-full mr-2' : 'left-full ml-2'} flex gap-1 bg-slate-900 border border-slate-700 rounded-lg p-1 z-10 shadow-lg opacity-0 group-hover:opacity-100 transition-opacity`}>
                                      <button 
                                          onClick={() => handleStartReply(msg)} 
                                          data-tooltip="Відповісти" 
                                          className="p-1.5 text-slate-400 hover:text-white rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 8l-4 4 4 4" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 6v8a4 4 0 01-4 4H6" /></svg>
                                      </button>
                                      {msg.out && (
                                      <button 
                                          onClick={() => handleStartEdit(msg)} 
                                          data-tooltip="Редагувати" 
                                          className="p-1.5 text-slate-400 hover:text-white rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                      </button>
                                      )}
                                      <button 
                                          onClick={() => handlePinMessage(msg.id, !!pinnedMessagesList.find(pm => pm.id === msg.id))} 
                                          data-tooltip={pinnedMessagesList.find(pm => pm.id === msg.id) ? "Відкріпити" : "Закріпити"} 
                                          className={`p-1.5 rounded-md transition hover:bg-slate-800 ${pinnedMessagesList.find(pm => pm.id === msg.id) ? 'text-blue-400' : 'text-slate-400 hover:text-white'}`}
                                      >
                                          <svg className="w-4 h-4" fill={pinnedMessagesList.find(pm => pm.id === msg.id) ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v8M5 10h14M19 10v1a3 3 0 01-3 3H8a3 3 0 01-3-3v-1M12 14v8" />
                                          </svg>
                                      </button>
                                      <button 
                                          onClick={() => setShowForwardModal({ messageIds: [String(msg.id)] })} 
                                          data-tooltip="Переслати" 
                                          className="p-1.5 text-slate-400 hover:text-white rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
                                      </button>
                                      <button 
                                          onClick={() => setShowSaveMessageModal({id: msg.id, text: msg.text, mediaPath: msg.mediaPath})} 
                                          data-tooltip="В нотатки" 
                                          className="p-1.5 text-slate-400 hover:text-yellow-400 rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                          </svg>
                                      </button>
                                      {canManageWarehouseOrders && (
                                      <button
                                          onClick={() => createWarehouseOrderFromMessage(msg)}
                                          data-tooltip="В замовлення"
                                          className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7l9-4 9 4-9 4-9-4zm0 5l9 4 9-4m-18 5l9 4 9-4" />
                                          </svg>
                                      </button>
                                      )}
                                      <button 
                                          onClick={() => handleDeleteMessage(msg.id)} 
                                          data-tooltip="Видалити" 
                                          className="p-1.5 text-slate-400 hover:text-red-500 rounded-md transition hover:bg-slate-800"
                                      >
                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                      </button>
                                  </div>
                                  {msg.replyTo && (
                                      <button
                                          type="button"
                                          onClick={() => scrollToMessageById(msg.replyTo)}
                                          className={`w-full text-left rounded-xl mb-2 px-3 py-2 border ${msg.out ? 'bg-blue-700/40 border-blue-300/20 hover:bg-blue-700/60' : 'bg-slate-900/50 border-slate-700 hover:bg-slate-900/70'} transition`}
                                      >
                                          <div className={`text-[11px] font-semibold ${msg.out ? 'text-blue-100' : 'text-blue-300'}`}>
                                              {replyTarget ? (replyTarget.out ? 'Ви' : (replyTarget.senderName || 'Повідомлення')) : `Відповідь на #${msg.replyTo}`}
                                          </div>
                                          <div className={`text-xs truncate ${msg.out ? 'text-blue-100/80' : 'text-slate-400'}`}>
                                              {replyTarget ? (replyTarget.text || (replyTarget.mediaPath ? '[Медіа]' : 'Повідомлення без тексту')) : 'Повідомлення поза поточним фрагментом'}
                                          </div>
                                      </button>
                                  )}
                                  {!msg.mediaPath && msg.hasMedia && (
                                      <div className="mb-2">
                                          <button
                                              type="button"
                                              onClick={() => handleDownloadMessageMedia(selectedDialog.id, msg.id)}
                                              className="text-xs px-3 py-2 rounded-lg border border-blue-500/40 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition"
                                          >
                                              {msg.mediaType === 'video' ? 'Завантажити відео' : 'Завантажити медіа'}
                                          </button>
                                      </div>
                                  )}
                                  {msg.mediaPath && (
                                      msg.mediaPath.match(/\.(jpg|jpeg|png|gif|webp)$/i) || msg.mediaPath.startsWith('blob:') ? (
                                        <img onLoad={handleMessageMediaLoad} onClick={() => setFullscreenImage(msg.mediaPath.startsWith('blob:') ? msg.mediaPath : buildUploadUrl(msg.mediaPath))} src={msg.mediaPath.startsWith('blob:') ? msg.mediaPath : buildUploadUrl(msg.mediaPath)} className="max-w-full rounded-xl mb-2 object-contain max-h-64 cursor-pointer hover:opacity-90 transition" alt="media" />
                                      ) : msg.mediaPath.match(/\.(mp4|webm)$/i) ? (
                                        <video onLoadedMetadata={handleMessageMediaLoad} src={buildUploadUrl(msg.mediaPath)} controls className="max-w-full rounded-xl mb-2 max-h-64"></video>
                                      ) : msg.mediaPath.match(/\.(ogg|mp3|wav)$/i) ? (
                                        <audio onLoadedMetadata={handleMessageMediaLoad} src={buildUploadUrl(msg.mediaPath)} controls className="w-full mb-2"></audio>
                                    ) : (
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <a
                                                href={`${API_URL}/chat/messages/${selectedDialog.id}/${msg.id}/file`}
                                                download={getMediaLabel(msg)}
                                                className="flex items-center gap-2 text-blue-300 hover:text-blue-200 underline break-all bg-slate-900/40 p-2 rounded-lg"
                                            >
                                                <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                                                {getMediaLabel(msg)}
                                            </a>
                                            <button
                                                type="button"
                                                onClick={() => handleOpenMediaFolder(msg.mediaPath)}
                                                className="text-xs px-3 py-2 rounded-lg border border-slate-600 bg-slate-900/60 text-slate-200 hover:bg-slate-800 transition"
                                            >
                                                Відкрити папку
                                            </button>
                                        </div>
                                      )
                                  )}
                                  {msg.contact && (
                                      <div className={`mb-2 rounded-xl border px-3 py-2 ${msg.out ? 'border-blue-300/30 bg-blue-700/30' : 'border-slate-600 bg-slate-900/60'}`}>
                                          <div className={`text-[11px] uppercase tracking-wider ${msg.out ? 'text-blue-100/80' : 'text-slate-400'}`}>Контакт</div>
                                          <div className="text-sm font-semibold">
                                              {[msg.contact.firstName, msg.contact.lastName].filter(Boolean).join(' ').trim() || 'Без імені'}
                                          </div>
                                          {msg.contact.phone && (
                                              <div className={`text-xs mt-0.5 ${msg.out ? 'text-blue-100/90' : 'text-slate-300'}`}>{msg.contact.phone}</div>
                                          )}
                                      </div>
                                  )}
                                  {!msg.out && selectedDialog.isGroup && msg.senderName && (
                                      <button
                                          type="button"
                                          className="text-[11px] font-bold text-sky-400 mb-0.5 hover:text-sky-300 underline-offset-2 hover:underline text-left"
                                          onClick={() => msg.senderId && openChatById(msg.senderId)}
                                          disabled={!msg.senderId}
                                          title={msg.senderId ? 'Відкрити діалог з користувачем' : 'Немає ID користувача'}
                                      >
                                          {msg.senderName}
                                      </button>
                                  )}
                                  <p className="break-words whitespace-pre-wrap">{renderTextWithLinks(msg.text)}</p>
                                  <div className={`text-[10px] mt-1 text-right flex items-center justify-end gap-1 ${msg.out ? 'text-blue-200' : 'text-slate-500'}`}>
                                      <span>{new Date(msg.date * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                      {msg.out && (
                                          <span className="flex items-center gap-1">
                                              {msg.sendStatus === 'failed' ? (
                                                  <span className="flex items-center gap-2 text-red-300" title={msg.sendError || 'Повідомлення не відправлено'}>
                                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
                                                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86l-7.55 13.08A1 1 0 003.61 18h16.78a1 1 0 00.87-1.5L13.71 3.86a1 1 0 00-1.74 0z" />
                                                      </svg>
                                                      <span>Помилка</span>
                                                      <button
                                                          type="button"
                                                          onClick={() => handleRetryFailedMessage(msg)}
                                                          className="underline hover:no-underline text-red-100"
                                                      >
                                                          Повторити
                                                      </button>
                                                  </span>
                                              ) : msg.sendStatus === 'sending' ? (
                                                  <span className="flex items-center gap-1 text-slate-300" title="Повідомлення відправляється">
                                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
                                                          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-9-9" />
                                                      </svg>
                                                  </span>
                                              ) : msg.isRead ? (
                                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
                                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 13l4 4L23 7" transform="translate(-2,0)" />
                                                  </svg>
                                              ) : (
                                                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3.5}>
                                                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                  </svg>
                                              )}
                                          </span>
                                      )}
                                  </div>
                              </div>
                          </div>
                      )})}
                      {!loadingMessages && messages.length === 0 && (
                          <div className="text-center py-10 text-slate-500 text-sm">Немає повідомлень (або медіа не підтримується)</div>
                      )}
                      <div ref={messagesEndRef} />
                  </div>

                  {/* Floating Scroll Button */}
                  {showScrollButton && (
                      <button 
                          onClick={scrollToBottom} 
                          className="absolute bottom-24 !right-4 md:!right-6 !left-auto w-11 h-11 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg shadow-blue-500/20 transition-all transform hover:scale-105 z-[95] flex items-center justify-center animate-bounce"
                          title="Вниз"
                          aria-label="Прокрутити вниз"
                      >
                          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                      </button>
                  )}

                  {/* Input Area */}
                  <div className="p-4 bg-slate-900/80 border-t border-slate-700/50 flex flex-col gap-2">
                      {replyingToMessage && (
                          <div className="flex items-start justify-between gap-3 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 py-3">
                              <div className="min-w-0">
                                  <div className="text-xs font-semibold text-blue-300">Відповідь на повідомлення #{replyingToMessage.id}</div>
                                  <div className="text-sm text-slate-300 truncate">{replyingToMessage.text || (replyingToMessage.mediaPath ? '[Медіа]' : 'Повідомлення без тексту')}</div>
                              </div>
                              <button onClick={() => setReplyingToMessage(null)} className="text-slate-400 hover:text-white transition">
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                          </div>
                      )}
                      {editingMessage && (
                          <div className="flex items-start justify-between gap-3 rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3">
                              <div className="min-w-0">
                                  <div className="text-xs font-semibold text-yellow-300">Редагування повідомлення #{editingMessage.id}</div>
                                  <div className="text-sm text-slate-300 truncate">{editingMessage.text || 'Повідомлення без тексту'}</div>
                              </div>
                              <button onClick={clearComposerMode} className="text-slate-400 hover:text-white transition">
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                          </div>
                      )}
                      {messageFiles.length > 0 && (
                          <div className="bg-slate-800 px-3 py-2 rounded-lg self-start max-w-md">
                              <div className="text-xs text-slate-400 mb-2">Файли: {messageFiles.length}/5</div>
                              <div className="space-y-1.5">
                                  {messageFiles.map((file, index) => (
                                      <div key={`${file.name}-${file.size}-${file.lastModified}-${index}`} className="flex items-center gap-2">
                                          <span className="text-sm text-blue-400 truncate max-w-xs">{file.name}</span>
                                          <span className="text-[11px] text-slate-500 shrink-0">{Math.max(1, Math.round(file.size / 1024))} KB</span>
                                          <button onClick={() => removeComposerFile(index)} className="text-red-400 hover:text-red-300 shrink-0" type="button">
                                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                          </button>
                                      </div>
                                  ))}
                              </div>
                          </div>
                      )}
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                          <input
                              type="file"
                              multiple
                              ref={fileInputRef}
                              onChange={(e) => addFilesToComposer(e.target.files)}
                              className="hidden"
                              id="file-upload"
                          />
                          <div className="flex gap-2 sm:flex-1 sm:min-w-0">
                          <label htmlFor="file-upload" className="cursor-pointer p-3 rounded-xl bg-slate-800 text-slate-400 hover:text-blue-400 hover:bg-slate-700 transition flex items-center justify-center shrink-0 self-start sm:self-auto">
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                              </svg>
                          </label>
                          <button
                              type="button"
                              onClick={openSendContactModal}
                              title="Надіслати контакт"
                              className="p-3 rounded-xl bg-slate-800 text-slate-400 hover:text-emerald-300 hover:bg-slate-700 transition flex items-center justify-center shrink-0 self-start sm:self-auto"
                          >
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5V9H2v11h5m10 0v-2a4 4 0 00-4-4H11a4 4 0 00-4 4v2m10 0H7m5-11a4 4 0 110 8 4 4 0 010-8z" />
                              </svg>
                          </button>
                          <div className="relative flex-1 min-w-0">
                              {showMentions && filteredParticipants.length > 0 && (
                                  <div className="absolute bottom-full left-0 mb-2 w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden z-[100]">
                                      <div className="p-2 border-b border-slate-700 bg-slate-800/50 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                                          Учасники чату
                                      </div>
                                      <div className="max-h-48 overflow-y-auto">
                                          {filteredParticipants.map((p, idx) => (
                                              <div 
                                                  key={p.id}
                                                  onClick={() => insertMention(p)}
                                                  className={`p-2 cursor-pointer flex items-center gap-3 transition ${activeMentionIndex === idx ? 'bg-blue-600 text-white' : 'hover:bg-slate-800 text-slate-300'}`}
                                              >
                                                  <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center font-bold text-xs shrink-0">
                                                      {p.firstName.charAt(0)}
                                                  </div>
                                                  <div className="flex flex-col min-w-0">
                                                      <span className="text-sm font-medium truncate">{p.firstName} {p.lastName}</span>
                                                      {p.username && <span className={`text-[10px] truncate ${activeMentionIndex === idx ? 'text-blue-200' : 'text-slate-500'}`}>@{p.username}</span>}
                                                  </div>
                                              </div>
                                          ))}
                                      </div>
                                  </div>
                              )}
                              <textarea 
                                  id="message-textarea"
                                  value={messageInput}
                                  onChange={handleInputChange}
                                  onKeyDown={(e) => {
                                      if (showMentions && filteredParticipants.length > 0) {
                                          if (e.key === 'ArrowDown') {
                                              e.preventDefault();
                                              setActiveMentionIndex(prev => (prev + 1) % filteredParticipants.length);
                                          } else if (e.key === 'ArrowUp') {
                                              e.preventDefault();
                                              setActiveMentionIndex(prev => (prev - 1 + filteredParticipants.length) % filteredParticipants.length);
                                          } else if (e.key === 'Enter' || e.key === 'Tab') {
                                              e.preventDefault();
                                              insertMention(filteredParticipants[activeMentionIndex]);
                                          } else if (e.key === 'Escape') {
                                              setShowMentions(false);
                                          }
                                      } else if (e.key === 'Enter' && !e.shiftKey) {
                                          e.preventDefault();
                                          handleSendMessage();
                                      }
                                  }}
                                  onPaste={(e) => {
                                      const items = e.clipboardData.items;
                                      for (let i = 0; i < items.length; i++) {
                                          if (items[i].type.indexOf('image') !== -1) {
                                              const file = items[i].getAsFile();
                                              addFilesToComposer([file]);
                                              e.preventDefault();
                                          }
                                      }
                                  }}
                                  placeholder={editingMessage ? "Відредагуйте повідомлення..." : "Написати повідомлення... (Shift+Enter для нового рядка, @ для згадки)"}
                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-none min-h-[48px] max-h-48"
                                  rows={Math.min(messageInput.split('\n').length || 1, 8)}
                              />
                          </div>
                          </div>
                          <button onClick={handleSendMessage} className={`w-full justify-center px-5 py-3 rounded-xl text-white font-medium transition flex items-center gap-2 shadow-lg sm:w-auto sm:shrink-0 whitespace-nowrap ${editingMessage ? 'bg-yellow-600 hover:bg-yellow-500 shadow-yellow-500/20' : 'bg-blue-600 hover:bg-blue-500 shadow-blue-500/20'}`}>
                              {editingMessage ? 'Зберегти' : 'Відправити'}
                              <svg className="w-4 h-4 ml-1" fill="currentColor" viewBox="0 0 20 20">
                                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                              </svg>
                          </button>
                      </div>
                  </div>
              </div>
          )}
      </div>
      )}

      {activeTab === 'requests' && (
      <div className="flex-1 flex bg-[#0b101e] h-screen overflow-hidden min-w-0">
          <div className="requests-templates-panel border-r border-slate-700/50 bg-slate-900/90 flex flex-col">
              <div className="p-6 border-b border-slate-700/50">
                  <h2 className="text-2xl font-bold text-slate-100">Заяви</h2>
                  <p className="text-sm text-slate-400 mt-2">Оберіть вид заяви, щоб відкрити шаблон і чат, куди вона буде відправлена.</p>
              </div>
              <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 p-4 space-y-3">
                  {loadingRequests && <div className="text-sm text-slate-400 p-4">Завантаження шаблонів...</div>}
                  {!loadingRequests && requestTemplates.length === 0 && (
                      <div className="text-sm text-slate-500 p-4 bg-slate-800/50 border border-slate-700 rounded-2xl">
                          Поки що немає доступних заяв.
                      </div>
                  )}
                  {requestTemplates.map(template => (
                      <button
                          key={template.id}
                          onClick={() => handleSelectRequestTemplate(template)}
                          className={`w-full text-left rounded-2xl border p-4 transition ${selectedRequestTemplate?.id === template.id ? 'border-blue-500/50 bg-blue-500/10 shadow-lg shadow-blue-900/10' : 'border-slate-700 bg-slate-800/60 hover:border-slate-600 hover:bg-slate-800'}`}
                      >
                          <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                  <div className="text-lg font-semibold text-slate-100">{template.title}</div>
                                  <div className="text-sm text-slate-400 mt-1 break-words">{template.description}</div>
                              </div>
                              <div className="w-11 h-11 rounded-2xl bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0">
                                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                              </div>
                          </div>
                          <div className="mt-4 text-xs text-slate-500 break-words">
                              Чат: {template.target_chat_name || 'ще не вибрано'}
                          </div>
                      </button>
                  ))}
              </div>
          </div>

          <div className="requests-workspace flex-1 min-w-0 overflow-y-auto p-4 md:p-6 xl:p-8">
              {!selectedRequestTemplate ? (
                  <div className="h-full flex items-center justify-center text-slate-500">
                      Оберіть заяву зліва.
                  </div>
              ) : (
                  <div className={`requests-content-grid ${showRequestPreview ? 'with-preview' : 'without-preview'}`}>
                      <div className="bg-slate-900 border border-slate-700/50 rounded-3xl shadow-2xl p-6 md:p-8">
                          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                              <div>
                                  <h3 className="text-2xl font-bold text-slate-100">{selectedRequestTemplate.title}</h3>
                                  <p className="text-sm text-slate-400 mt-2 max-w-2xl">{selectedRequestTemplate.description}</p>
                              </div>
                              <div className="px-4 py-3 rounded-2xl bg-slate-800 border border-slate-700 text-sm text-slate-300">
                                  Чат призначення:
                                  <div className="text-slate-100 font-semibold mt-1">{selectedRequestTemplate.target_chat_name || 'ще не вибрано'}</div>
                              </div>
                          </div>

                          <div className="mt-6">
                              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Куди відправляти</label>
                              <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                                  <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                      <div>
                                          <div className="text-sm font-medium text-slate-200">Стандартний чат для цього шаблону</div>
                                          <div className="text-xs text-slate-400 mt-1">
                                              Вибраний чат збережеться, і при наступному відкритті заяви він уже буде підставлений.
                                          </div>
                                      </div>
                                      <button
                                          onClick={loadRequestTemplates}
                                          disabled={loadingRequests || requestConfigSaving}
                                          className="px-4 py-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 transition disabled:opacity-50 shrink-0"
                                      >
                                          Оновити
                                      </button>
                                  </div>

                                  <input
                                      type="text"
                                      value={requestChatSearch}
                                      onChange={(e) => setRequestChatSearch(e.target.value)}
                                      placeholder="Пошук чату..."
                                      className="w-full bg-slate-900/80 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                  />

                                  <select
                                      value={selectedRequestTemplate.target_chat_id || ''}
                                      onChange={(e) => handleSaveRequestTargetChat(e.target.value)}
                                      className="w-full bg-slate-900/80 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                  >
                                      <option value="">Оберіть чат</option>
                                      {filteredRequestDialogs.map(dialog => (
                                          <option key={dialog.id} value={dialog.id}>{dialog.name}</option>
                                      ))}
                                  </select>

                                  {requestChatSearch && filteredRequestDialogs.length === 0 && (
                                      <div className="text-sm text-slate-400">
                                          За запитом нічого не знайдено.
                                      </div>
                                  )}
                              </div>
                          </div>

                          {selectedRequestTemplate.code === 'logistics_request' ? (
                              <div className="mt-8 space-y-6">
                                  <div className="rounded-2xl border border-slate-700 bg-slate-800/30 p-4 space-y-4">
                                      <label className="block text-sm font-medium text-slate-300">Кого відмітити в повідомленні</label>
                                      <div className="flex flex-wrap gap-2">
                                          {(Array.isArray(requestFormValues.selected_mentions) ? requestFormValues.selected_mentions : []).map(mention => (
                                              <button
                                                  key={mention}
                                                  type="button"
                                                  onClick={() => handleToggleRequestMention(mention)}
                                                  className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm hover:bg-amber-500/20 transition"
                                              >
                                                  {mention} ×
                                              </button>
                                          ))}
                                          {(!Array.isArray(requestFormValues.selected_mentions) || requestFormValues.selected_mentions.length === 0) && (
                                              <span className="text-xs text-slate-500">Нікого не обрано</span>
                                          )}
                                      </div>

                                      {!selectedRequestTemplate.target_chat_id ? (
                                          <div className="text-sm text-slate-500">
                                              Спочатку вибери чат призначення, тоді тут з’являться учасники для відмітки.
                                          </div>
                                      ) : loadingRequestParticipants ? (
                                          <div className="text-sm text-slate-400">Завантаження учасників...</div>
                                      ) : (
                                          <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                                              {requestTargetParticipants.map(participant => {
                                                  const mention = getRequestParticipantMentionValue(participant);
                                                  const selectedMentions = Array.isArray(requestFormValues.selected_mentions) ? requestFormValues.selected_mentions : [];
                                                  const isSelected = selectedMentions.includes(mention);
                                                  return (
                                                      <button
                                                          key={participant.id}
                                                          type="button"
                                                          onClick={() => handleToggleRequestMention(mention)}
                                                          className={`px-3 py-2 rounded-xl text-sm border transition ${isSelected ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:bg-slate-800'}`}
                                                      >
                                                          {getRequestParticipantLabel(participant)}
                                                      </button>
                                                  );
                                              })}
                                              {requestTargetParticipants.length === 0 && (
                                                  <div className="text-sm text-slate-500">Не знайдено учасників у цьому чаті.</div>
                                              )}
                                          </div>
                                      )}

                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Текст повідомлення в чат (разом з файлом)</label>
                                          <textarea
                                              value={requestFormValues.logistics_chat_message || ''}
                                              onChange={(e) => handleRequestFieldChange('logistics_chat_message', e.target.value)}
                                              rows={3}
                                              placeholder="Вкажи супровідний текст. Він піде в чат перед DOCX."
                                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[90px]"
                                          />
                                      </div>
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Дата подачі заявки *</label>
                                          <input type="text" value={requestFormValues.submission_date || ''} onChange={(e) => handleRequestFieldChange('submission_date', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" />
                                      </div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Контактний номер телефону *</label>
                                          <input type="text" value={requestFormValues.requester_phone || ''} onChange={(e) => handleRequestFieldChange('requester_phone', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" />
                                      </div>
                                      <div className="md:col-span-2">
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Хто подає заявку (ПІБ / підрозділ) *</label>
                                          <input type="text" value={requestFormValues.requester_name_division || ''} onChange={(e) => handleRequestFieldChange('requester_name_division', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" />
                                      </div>
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div><label className="block text-sm font-medium text-slate-300 mb-2">Тип вантажу *</label><input type="text" value={requestFormValues.cargo_type || ''} onChange={(e) => handleRequestFieldChange('cargo_type', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Кількість місць *</label>
                                          <select
                                              value={String(getNormalizedPlaceCount(requestFormValues))}
                                              onChange={(e) => handleLogisticsPlaceCountChange(e.target.value)}
                                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                          >
                                              {Array.from({ length: 10 }, (_, i) => i + 1).map(num => (
                                                  <option key={num} value={num}>{num}</option>
                                              ))}
                                          </select>
                                      </div>
                                      <div><label className="block text-sm font-medium text-slate-300 mb-2">Орієнтовна вага (кг) *</label><input type="text" value={requestFormValues.cargo_weight_kg || ''} onChange={(e) => handleRequestFieldChange('cargo_weight_kg', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      <div><label className="block text-sm font-medium text-slate-300 mb-2">Довжина найбільшої деталі *</label><input type="text" value={requestFormValues.longest_part_length || ''} onChange={(e) => handleRequestFieldChange('longest_part_length', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      <div className="md:col-span-2">
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Габарити для кожного місця (Д×Ш×В, см) *</label>
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                              {getPlaceDimensionsArray(requestFormValues, getNormalizedPlaceCount(requestFormValues)).map((dimension, index) => (
                                                  <div key={index}>
                                                      <label className="block text-xs text-slate-500 mb-1">Місце {index + 1}</label>
                                                      <input
                                                          type="text"
                                                          value={dimension}
                                                          onChange={(e) => handleLogisticsPlaceDimensionChange(index, e.target.value)}
                                                          placeholder="2400×1200×720"
                                                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                                      />
                                                  </div>
                                              ))}
                                          </div>
                                      </div>
                                      <div className="md:col-span-2">
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Детальний опис / специфікація</label>
                                          <textarea
                                              value={requestFormValues.cargo_detailed_description || ''}
                                              onChange={(e) => handleRequestFieldChange('cargo_detailed_description', e.target.value)}
                                              rows={5}
                                              placeholder="За потреби дозаповни деталі або встав специфікацію товару..."
                                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[140px]"
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Спец. умови *</label>
                                          <select value={requestFormValues.special_conditions_required || 'no'} onChange={(e) => handleRequestFieldChange('special_conditions_required', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                              <option value="no">Ні</option>
                                              <option value="yes">Так</option>
                                          </select>
                                      </div>
                                      {String(requestFormValues.special_conditions_required || 'no') === 'yes' && (
                                          <div className="md:col-span-2">
                                              <label className="block text-sm font-medium text-slate-300 mb-2">Уточнення спец. умов</label>
                                              <textarea
                                                  value={requestFormValues.special_conditions_note || ''}
                                                  onChange={(e) => handleRequestFieldChange('special_conditions_note', e.target.value)}
                                                  rows={3}
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[100px]"
                                              />
                                          </div>
                                      )}
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Форма оплати *</label>
                                          <select value={requestFormValues.payment_form || 'cash'} onChange={(e) => handleRequestFieldChange('payment_form', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                              <option value="cash">Готівка</option>
                                              <option value="cashless_vat">Безготівка з ПДВ</option>
                                              <option value="other">Інше</option>
                                          </select>
                                      </div>
                                      {String(requestFormValues.payment_form || 'cash') === 'cashless_vat' && (
                                          <div className="md:col-span-2">
                                              <label className="block text-sm font-medium text-slate-300 mb-2">Юр особа для рахунку</label>
                                              <textarea
                                                  value={requestFormValues.invoice_legal_entity || ''}
                                                  onChange={(e) => handleRequestFieldChange('invoice_legal_entity', e.target.value)}
                                                  rows={3}
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[100px]"
                                              />
                                          </div>
                                      )}
                                      {String(requestFormValues.payment_form || 'cash') === 'other' && (
                                          <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Форма оплати: інше *</label><input type="text" value={requestFormValues.payment_form_other || ''} onChange={(e) => handleRequestFieldChange('payment_form_other', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      )}
                                      <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Оформлення документів для оплати</label><input type="text" value={requestFormValues.payment_docs_note || ''} onChange={(e) => handleRequestFieldChange('payment_docs_note', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                  </div>

                                  <div className="rounded-2xl border border-slate-700 bg-slate-800/30 p-4 space-y-4">
                                      <div className="flex flex-wrap gap-3 items-end">
                                          <div className="flex-1 min-w-[260px]">
                                              <label className="block text-sm font-medium text-slate-300 mb-2">Шаблон складу відправлення</label>
                                              <select value={requestFormValues.pickup_template_id || ''} onChange={(e) => applyPickupTemplateById(e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                                  <option value="">Не обрано</option>
                                                  {logisticsOptions.warehouses.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                                              </select>
                                          </div>
                                          <button type="button" onClick={handleSavePickupTemplate} disabled={savingPickupTemplate || loadingLogisticsOptions} className="px-4 py-3 rounded-xl bg-slate-900 text-slate-200 border border-slate-700 hover:bg-slate-800 transition disabled:opacity-50">
                                              {savingPickupTemplate ? 'Збереження...' : 'Зберегти як шаблон'}
                                          </button>
                                      </div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Назва обʼєкта (відправлення) *</label><input type="text" value={requestFormValues.pickup_object_name || ''} onChange={(e) => handleRequestFieldChange('pickup_object_name', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Графік роботи</label><input type="text" value={requestFormValues.pickup_work_schedule || ''} onChange={(e) => handleRequestFieldChange('pickup_work_schedule', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Адреса *</label><input type="text" value={requestFormValues.pickup_address || ''} onChange={(e) => handleRequestFieldChange('pickup_address', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Геолокація</label><input type="text" value={requestFormValues.pickup_geolocation || ''} onChange={(e) => handleRequestFieldChange('pickup_geolocation', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Контактна особа</label><input type="text" value={requestFormValues.pickup_contact_person || ''} onChange={(e) => handleRequestFieldChange('pickup_contact_person', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Телефон</label><input type="text" value={requestFormValues.pickup_contact_phone || ''} onChange={(e) => handleRequestFieldChange('pickup_contact_phone', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Час готовності вантажу</label><input type="text" value={requestFormValues.pickup_ready_time || ''} onChange={(e) => handleRequestFieldChange('pickup_ready_time', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Спосіб завантаження</label><input type="text" value={requestFormValues.pickup_loading_method || ''} onChange={(e) => handleRequestFieldChange('pickup_loading_method', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      </div>
                                  </div>

                                  <div className="rounded-2xl border border-slate-700 bg-slate-800/30 p-4 space-y-4">
                                      <div className="flex flex-wrap gap-3 items-end">
                                          <div className="flex-1 min-w-[260px]">
                                              <label className="block text-sm font-medium text-slate-300 mb-2">Шаблон одержувача</label>
                                              <select value={requestFormValues.delivery_template_id || ''} onChange={(e) => applyDeliveryTemplateById(e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                                  <option value="">Не обрано</option>
                                                  {logisticsOptions.recipients.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                                              </select>
                                          </div>
                                          <button type="button" onClick={handleSaveDeliveryTemplate} disabled={savingDeliveryTemplate || loadingLogisticsOptions} className="px-4 py-3 rounded-xl bg-slate-900 text-slate-200 border border-slate-700 hover:bg-slate-800 transition disabled:opacity-50">
                                              {savingDeliveryTemplate ? 'Збереження...' : 'Зберегти як шаблон'}
                                          </button>
                                      </div>
                                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Назва обʼєкта (доставка) *</label><input type="text" value={requestFormValues.delivery_object_name || ''} onChange={(e) => handleRequestFieldChange('delivery_object_name', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Бажаний час доставки</label><input type="text" value={requestFormValues.delivery_desired_time || ''} onChange={(e) => handleRequestFieldChange('delivery_desired_time', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Адреса *</label><input type="text" value={requestFormValues.delivery_address || ''} onChange={(e) => handleRequestFieldChange('delivery_address', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Контактна особа</label><input type="text" value={requestFormValues.delivery_contact_person || ''} onChange={(e) => handleRequestFieldChange('delivery_contact_person', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div><label className="block text-sm font-medium text-slate-300 mb-2">Телефон</label><input type="text" value={requestFormValues.delivery_contact_phone || ''} onChange={(e) => handleRequestFieldChange('delivery_contact_phone', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                          <div className="md:col-span-2"><label className="block text-sm font-medium text-slate-300 mb-2">Спосіб розвантаження</label><input type="text" value={requestFormValues.delivery_unloading_method || ''} onChange={(e) => handleRequestFieldChange('delivery_unloading_method', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" /></div>
                                      </div>
                                  </div>

                                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Потреба у вантажниках *</label>
                                          <select value={requestFormValues.need_loaders || 'no'} onChange={(e) => handleRequestFieldChange('need_loaders', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                              <option value="yes">Так</option>
                                              <option value="no">Ні</option>
                                          </select>
                                      </div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Зворотня доставка документів *</label>
                                          <select value={requestFormValues.need_return_docs || 'no'} onChange={(e) => handleRequestFieldChange('need_return_docs', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                              <option value="yes">Так</option>
                                              <option value="no">Ні</option>
                                          </select>
                                      </div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Пріоритет *</label>
                                          <select value={requestFormValues.priority || 'standard'} onChange={(e) => handleRequestFieldChange('priority', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition">
                                              <option value="standard">Стандартна доставка</option>
                                              <option value="urgent">Термінова доставка</option>
                                              <option value="other">Інше</option>
                                          </select>
                                      </div>
                                      <div>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Пріоритет: інше</label>
                                          <input type="text" value={requestFormValues.priority_other || ''} onChange={(e) => handleRequestFieldChange('priority_other', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" />
                                      </div>
                                      <div className="md:col-span-2">
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Інші важливі примітки / інструкції</label>
                                          <textarea value={requestFormValues.additional_notes || ''} onChange={(e) => handleRequestFieldChange('additional_notes', e.target.value)} rows={4} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[110px]" />
                                      </div>
                                      <div className="md:col-span-2">
                                          <label className="block text-sm font-medium text-slate-300 mb-2">Видаткова / примітка для водія</label>
                                          <input type="text" value={requestFormValues.driver_waybill_note || ''} onChange={(e) => handleRequestFieldChange('driver_waybill_note', e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition" />
                                      </div>
                                  </div>
                              </div>
                          ) : (
                              <div className="mt-8 space-y-5">
                                  {selectedRequestTemplate.code === 'purchase_request' && (
                                      <div className="rounded-2xl border border-slate-700 bg-slate-800/30 p-4 space-y-3">
                                          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-3">
                                              <label className="block text-sm font-medium text-slate-300">Текст повідомлення в чат + відмітки</label>
                                              <div className="flex flex-wrap gap-2">
                                                  {(Array.isArray(requestFormValues.selected_mentions) ? requestFormValues.selected_mentions : []).map(mention => (
                                                      <button
                                                          key={mention}
                                                          type="button"
                                                          onClick={() => handleToggleRequestMention(mention)}
                                                          className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm hover:bg-amber-500/20 transition"
                                                      >
                                                          {mention} ×
                                                      </button>
                                                  ))}
                                                  {(!Array.isArray(requestFormValues.selected_mentions) || requestFormValues.selected_mentions.length === 0) && (
                                                      <span className="text-xs text-slate-500">Нікого не обрано</span>
                                                  )}
                                              </div>
                                              {!selectedRequestTemplate.target_chat_id ? (
                                                  <div className="text-sm text-slate-500">
                                                      Спочатку вибери чат призначення, тоді тут з’являться учасники для відмітки.
                                                  </div>
                                              ) : loadingRequestParticipants ? (
                                                  <div className="text-sm text-slate-400">Завантаження учасників...</div>
                                              ) : (
                                                  <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                                                      {requestTargetParticipants.map(participant => {
                                                          const mention = getRequestParticipantMentionValue(participant);
                                                          const selectedMentions = Array.isArray(requestFormValues.selected_mentions) ? requestFormValues.selected_mentions : [];
                                                          const isSelected = selectedMentions.includes(mention);
                                                          return (
                                                              <button
                                                                  key={participant.id}
                                                                  type="button"
                                                                  onClick={() => handleToggleRequestMention(mention)}
                                                                  className={`px-3 py-2 rounded-xl text-sm border transition ${isSelected ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:bg-slate-800'}`}
                                                              >
                                                                  {getRequestParticipantLabel(participant)}
                                                              </button>
                                                          );
                                                      })}
                                                      {requestTargetParticipants.length === 0 && (
                                                          <div className="text-sm text-slate-500">Не знайдено учасників у цьому чаті.</div>
                                                      )}
                                                  </div>
                                              )}
                                              <textarea
                                                  value={requestFormValues.purchase_chat_message || ''}
                                                  onChange={(e) => handleRequestFieldChange('purchase_chat_message', e.target.value)}
                                                  rows={3}
                                                  placeholder="Супровідний текст перед DOCX"
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[90px]"
                                              />
                                          </div>

                                          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                                  <div>
                                                      <div className="text-sm font-semibold text-slate-200">Вставка позицій з Excel</div>
                                                  <div className="text-xs text-slate-500 mt-1">Скопіюй рядки з Excel і встав сюди. Колонки: Найменування, Код обладнання/виробу, Завод, Од.вимір., К-сть, Примітки.</div>
                                              </div>
                                              <div className="flex gap-2">
                                                  <button
                                                      type="button"
                                                      onClick={handleApplyPurchaseImport}
                                                      className="px-3 py-2 rounded-lg border border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20 transition text-sm"
                                                  >
                                                      Підставити в заявку
                                                  </button>
                                              </div>
                                          </div>

                                          <textarea
                                              value={purchaseImportText}
                                              onChange={(e) => {
                                                  setPurchaseImportText(e.target.value);
                                              }}
                                              rows={4}
                                              placeholder={"Встав дані з Excel сюди...\nНаприклад:\nЗапобіжник Victron 150A, 80B\tMEGA-fuse 150A/80V\tVictron energy\tшт.\t1\t\nБлок розподільчий\tEDBM-6\tETI\tшт.\t1\t1102403"}
                                              className="w-full bg-slate-900/80 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[100px]"
                                          />

                                          {purchaseImportError && (
                                              <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2">
                                                  {purchaseImportError}
                                              </div>
                                          )}

                                          {purchaseImportRows.length > 0 && (
                                              <div className="rounded-xl border border-slate-700 overflow-hidden">
                                                  <div className="text-xs text-slate-400 px-3 py-2 border-b border-slate-700 bg-slate-900/70">
                                                      Розпізнано позицій: {purchaseImportRows.length}
                                                  </div>
                                                  <div className="max-h-52 overflow-y-auto">
                                                      {purchaseImportRows.map((row) => (
                                                          <div key={row.rowNumber} className="grid grid-cols-[36px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_80px_70px_minmax(0,1.2fr)] gap-2 px-3 py-2 border-b border-slate-800 text-xs">
                                                              <div className="text-slate-500">{row.rowNumber}</div>
                                                              <div className="truncate text-slate-200">{row.itemName || '—'}</div>
                                                              <div className="truncate text-slate-300">{row.equipmentCode || '—'}</div>
                                                              <div className="truncate text-slate-300">{row.plant || '—'}</div>
                                                              <div className="truncate text-slate-300">{row.unit || '—'}</div>
                                                              <div className="truncate text-slate-100">{row.qty || '—'}</div>
                                                              <div className="truncate text-slate-400">{row.notes || '—'}</div>
                                                          </div>
                                                      ))}
                                                  </div>
                                              </div>
                                          )}

                                          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-3">
                                              <div className="text-xs text-slate-400">Додати товар вручну</div>
                                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                                  <input value={purchaseManualItem.itemName} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, itemName: e.target.value }))} placeholder="Найменування *" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition md:col-span-2" />
                                                  <input value={purchaseManualItem.equipmentCode} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, equipmentCode: e.target.value }))} placeholder="Код обладнання, виробу" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition" />
                                                  <input value={purchaseManualItem.plant} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, plant: e.target.value }))} placeholder="Завод" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition" />
                                                  <input list="purchase-unit-options" value={purchaseManualItem.unit} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, unit: e.target.value }))} placeholder="Од.вимір." className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition" />
                                                  <input value={purchaseManualItem.qty} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, qty: e.target.value }))} placeholder="К-сть" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition" />
                                                  <input value={purchaseManualItem.notes} onChange={(e) => setPurchaseManualItem(prev => ({ ...prev, notes: e.target.value }))} placeholder="Примітки" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition md:col-span-2" />
                                                  <datalist id="purchase-unit-options">
                                                      {PURCHASE_UNIT_OPTIONS.map((unit) => (
                                                          <option key={unit} value={unit} />
                                                      ))}
                                                  </datalist>
                                              </div>
                                              <button type="button" onClick={handleAddManualPurchaseItem} className="px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition text-sm">
                                                  Додати товар
                                              </button>
                                          </div>

                                          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-3">
                                              <div className="text-xs text-slate-400">Шаблони для менеджера і адреси</div>
                                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                  <div>
                                                      <label className="block text-xs text-slate-500 mb-1">Шаблон менеджера</label>
                                                      <select
                                                          onChange={(e) => applyPurchaseManagerTemplateById(e.target.value)}
                                                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
                                                          defaultValue=""
                                                      >
                                                          <option value="">Оберіть менеджера</option>
                                                          {purchaseTemplateOptions.managers.map(item => (
                                                              <option key={item.value} value={item.value}>{item.label}</option>
                                                          ))}
                                                      </select>
                                                  </div>
                                                  <div className="flex items-end">
                                                      <button type="button" onClick={handleSavePurchaseManagerTemplate} disabled={savingPurchaseManagerTemplate || loadingPurchaseOptions} className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition text-sm disabled:opacity-50">
                                                          {savingPurchaseManagerTemplate ? 'Збереження...' : 'Зберегти менеджера'}
                                                      </button>
                                                  </div>
                                                  <div>
                                                      <label className="block text-xs text-slate-500 mb-1">Шаблон адреси</label>
                                                      <select
                                                          onChange={(e) => applyPurchaseAddressTemplateById(e.target.value)}
                                                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
                                                          defaultValue=""
                                                      >
                                                          <option value="">Оберіть адресу</option>
                                                          {purchaseTemplateOptions.addresses.map(item => (
                                                              <option key={item.value} value={item.value}>{item.label}</option>
                                                          ))}
                                                      </select>
                                                  </div>
                                                  <div className="flex items-end">
                                                      <button type="button" onClick={handleSavePurchaseAddressTemplate} disabled={savingPurchaseAddressTemplate || loadingPurchaseOptions} className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition text-sm disabled:opacity-50">
                                                          {savingPurchaseAddressTemplate ? 'Збереження...' : 'Зберегти адресу'}
                                                      </button>
                                                  </div>
                                              </div>
                                          </div>
                                      </div>
                                  )}

                                  {selectedRequestTemplate.code === 'tk_delivery_request' && (
                                      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3 space-y-3">
                                          <div className="text-xs text-slate-400">Шаблони для ТК (менеджер + отримувач)</div>
                                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                              <div>
                                                  <label className="block text-xs text-slate-500 mb-1">Збережені менеджери</label>
                                                  <select
                                                      onChange={(e) => applyTkManagerTemplateById(e.target.value)}
                                                      className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
                                                      defaultValue=""
                                                  >
                                                      <option value="">Оберіть менеджера</option>
                                                      {tkTemplateOptions.managers.map(item => (
                                                          <option key={item.value} value={item.value}>{item.label}</option>
                                                      ))}
                                                  </select>
                                              </div>
                                              <div className="flex items-end">
                                                  <button
                                                      type="button"
                                                      onClick={handleSaveTkManagerTemplate}
                                                      disabled={savingTkManagerTemplate || loadingTkOptions}
                                                      className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition text-sm disabled:opacity-50"
                                                  >
                                                      {savingTkManagerTemplate ? 'Збереження...' : 'Зберегти менеджера'}
                                                  </button>
                                              </div>
                                              <div>
                                                  <label className="block text-xs text-slate-500 mb-1">Шаблон отримувача</label>
                                                  <select
                                                      onChange={(e) => applyTkRecipientTemplateById(e.target.value)}
                                                      className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-blue-500 transition"
                                                      defaultValue=""
                                                  >
                                                      <option value="">Оберіть отримувача</option>
                                                      {tkTemplateOptions.recipients.map(item => (
                                                          <option key={item.value} value={item.value}>{item.label}</option>
                                                      ))}
                                                  </select>
                                              </div>
                                              <div className="flex items-end">
                                                  <button
                                                      type="button"
                                                      onClick={handleSaveTkRecipientTemplate}
                                                      disabled={savingTkRecipientTemplate || loadingTkOptions}
                                                      className="w-full px-3 py-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 transition text-sm disabled:opacity-50"
                                                  >
                                                      {savingTkRecipientTemplate ? 'Збереження...' : 'Зберегти отримувача'}
                                                  </button>
                                              </div>
                                          </div>
                                      </div>
                                  )}

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                  {selectedRequestTemplate.fields
                                      .filter(field => isRequestFieldVisible(field, requestFormValues))
                                      .filter(field => !(selectedRequestTemplate.code === 'purchase_request' && (field.key === 'purchase_chat_message' || field.key === 'selected_mentions' || field.key === 'items_list')))
                                      .map(field => (
                                      <div key={field.key} className={field.type === 'textarea' || field.type === 'multi_contact_mentions' || field.key === 'issue_recipient_name' ? 'md:col-span-2' : ''}>
                                          <label className="block text-sm font-medium text-slate-300 mb-2">
                                              {field.label}
                                              {field.required && <span className="text-red-400 ml-1">*</span>}
                                          </label>
                                          {selectedRequestTemplate?.code === 'warehouse_issue_request' && field.key === 'items_list' && (
                                              <div className="text-xs text-slate-500 mb-2">Можна вставити скріншот у це поле (`Ctrl/Cmd + V`) і він додасться у вкладення заявки.</div>
                                          )}
                                          {field.helpText && (
                                              <div className="text-xs text-slate-500 mb-2">{field.helpText}</div>
                                          )}
                                          {field.type === 'textarea' ? (
                                              <textarea
                                                  value={requestFormValues[field.key] || ''}
                                                  onChange={(e) => handleRequestFieldChange(field.key, e.target.value)}
                                                  onPaste={selectedRequestTemplate?.code === 'warehouse_issue_request' && field.key === 'items_list' ? handleRequestItemsPaste : undefined}
                                                  rows={field.key === 'purpose' ? 6 : 3}
                                                  placeholder={field.placeholder || ''}
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition resize-y min-h-[110px]"
                                              />
                                          ) : field.type === 'select' ? (
                                              <select
                                                  value={requestFormValues[field.key] ?? field.defaultValue ?? ''}
                                                  onChange={(e) => handleRequestFieldChange(field.key, e.target.value)}
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                              >
                                                  {(field.options || []).map(option => (
                                                      <option key={option.value} value={option.value}>{option.label}</option>
                                                  ))}
                                              </select>
                                          ) : field.type === 'multi_contact_mentions' ? (
                                              <div className="rounded-2xl border border-slate-700 bg-slate-800/40 p-4 space-y-3">
                                                  <div className="flex flex-wrap gap-2">
                                                      {(field.defaultMentions || []).map(mention => (
                                                          <span key={mention} className="px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 text-sm">
                                                              {mention}
                                                          </span>
                                                      ))}
                                                      {(Array.isArray(requestFormValues[field.key]) ? requestFormValues[field.key] : []).map(mention => (
                                                          <button
                                                              key={mention}
                                                              type="button"
                                                              onClick={() => handleToggleRequestMention(mention)}
                                                              className="px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300 text-sm hover:bg-amber-500/20 transition"
                                                          >
                                                              {mention} ×
                                                          </button>
                                                      ))}
                                                  </div>

                                                  {!selectedRequestTemplate.target_chat_id ? (
                                                      <div className="text-sm text-slate-500">
                                                          Спочатку вибери стандартну групу відправки, тоді тут з’являться її учасники.
                                                      </div>
                                                  ) : (
                                                      <>
                                                          {loadingRequestParticipants ? (
                                                              <div className="text-sm text-slate-400">Завантаження учасників...</div>
                                                          ) : (
                                                              <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto pr-1">
                                                                  {requestTargetParticipants.map(participant => {
                                                                      const mention = getRequestParticipantMentionValue(participant);
                                                                      const selectedMentions = Array.isArray(requestFormValues[field.key]) ? requestFormValues[field.key] : [];
                                                                      const isSelected = selectedMentions.includes(mention);
                                                                      return (
                                                                          <button
                                                                              key={participant.id}
                                                                              type="button"
                                                                              onClick={() => handleToggleRequestMention(mention)}
                                                                              className={`px-3 py-2 rounded-xl text-sm border transition ${isSelected ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-slate-900/60 text-slate-300 border-slate-700 hover:bg-slate-800'}`}
                                                                          >
                                                                              {getRequestParticipantLabel(participant)}
                                                                          </button>
                                                                      );
                                                                  })}
                                                                  {!loadingRequestParticipants && requestTargetParticipants.length === 0 && (
                                                                      <div className="text-sm text-slate-500">Не знайдено учасників для відмітки.</div>
                                                                  )}
                                                              </div>
                                                          )}
                                                      </>
                                                  )}
                                              </div>
                                          ) : (
                                              <input
                                                  type="text"
                                                  value={requestFormValues[field.key] ?? ''}
                                                  onChange={(e) => handleRequestFieldChange(field.key, e.target.value)}
                                                  placeholder={field.placeholder || ''}
                                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 transition"
                                              />
                                          )}
                                      </div>
                                  ))}
                              </div>
                              </div>
                          )}

                          {(selectedRequestTemplate.code === 'warehouse_issue_request' || selectedRequestTemplate.code === 'tk_delivery_request') && (
                              <div className="mt-6">
                                  <label className="block text-sm font-medium text-slate-300 mb-2">Фото або файл до заявки</label>
                                  <input
                                      ref={requestFileInputRef}
                                      type="file"
                                      className="hidden"
                                      onChange={(e) => handleRequestAttachmentSelect(e.target.files?.[0] || null)}
                                  />
                                  <div
                                      onDragEnter={(e) => {
                                          e.preventDefault();
                                          setRequestDropActive(true);
                                      }}
                                      onDragOver={(e) => {
                                          e.preventDefault();
                                          setRequestDropActive(true);
                                      }}
                                      onDragLeave={(e) => {
                                          e.preventDefault();
                                          setRequestDropActive(false);
                                      }}
                                      onDrop={(e) => {
                                          e.preventDefault();
                                          setRequestDropActive(false);
                                          handleRequestAttachmentSelect(e.dataTransfer.files?.[0] || null);
                                      }}
                                      className={`rounded-2xl border-2 border-dashed p-5 transition ${requestDropActive ? 'border-blue-400 bg-blue-500/10' : 'border-slate-700 bg-slate-800/30'}`}
                                  >
                                      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                                          <div>
                                              <div className="text-sm font-medium text-slate-200">Перетягни сюди фото або файл</div>
                                              <div className="text-xs text-slate-500 mt-1">Або вибери файл вручну. Він відправиться разом із текстом заявки.</div>
                                          </div>
                                          <button
                                              type="button"
                                              onClick={() => requestFileInputRef.current?.click()}
                                              className="px-4 py-2 rounded-xl bg-slate-900 text-slate-200 border border-slate-700 hover:bg-slate-800 transition"
                                          >
                                              Обрати файл
                                          </button>
                                      </div>

                                      {requestAttachment && (
                                          <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3">
                                              <div className="min-w-0">
                                                  <div className="text-sm text-slate-200 truncate">{requestAttachment.name}</div>
                                                  <div className="text-xs text-slate-500">{Math.max(1, Math.round(requestAttachment.size / 1024))} KB</div>
                                              </div>
                                              <button
                                                  type="button"
                                                  onClick={clearRequestAttachment}
                                                  className="text-red-300 hover:text-red-200 transition"
                                              >
                                                  Прибрати
                                              </button>
                                          </div>
                                      )}
                                  </div>
                              </div>
                          )}

                          {requestFeedback && (
                              <div className={`mt-6 rounded-2xl border px-4 py-3 text-sm ${requestFeedback.type === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
                                  {requestFeedback.text}
                              </div>
                          )}

                          <div className="mt-6 flex justify-end">
                              <button
                                  onClick={handleSendRequest}
                                  disabled={requestSending || !selectedRequestTemplate.target_chat_id}
                                  className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold transition shadow-lg shadow-blue-900/20"
                              >
                                  {requestSending
                                      ? 'Відправка...'
                                      : selectedRequestTemplate.code === 'logistics_request'
                                          ? 'Згенерувати DOCX і відправити'
                                          : 'Відправити заяву'}
                              </button>
                          </div>
                      </div>

                      {showRequestPreview && (
                      <div className="request-preview-card bg-slate-900 border border-slate-700/50 rounded-3xl shadow-2xl p-6 flex flex-col min-h-[420px]">
                          <div className="flex items-center justify-between gap-3 mb-4">
                              <div>
                                  <h4 className="text-lg font-semibold text-slate-100">Прев’ю тексту</h4>
                                  <p className="text-sm text-slate-400 mt-1">Так заява виглядатиме перед відправкою в Telegram.</p>
                              </div>
                              <button
                                  onClick={() => setShowRequestPreview(false)}
                                  className="inline-flex items-center justify-center p-2 rounded-xl border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 transition shrink-0"
                                  title="Сховати превʼю"
                              >
                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5v14" />
                                  </svg>
                              </button>
                          </div>
                          <div className="request-preview-content flex-1 bg-slate-950/70 border border-slate-800 rounded-2xl p-5 overflow-y-auto">
                              <pre className="whitespace-pre-wrap break-words text-sm leading-7 text-slate-200 font-sans">{requestPreview}</pre>
                          </div>
                      </div>
                      )}
                  </div>
              )}
              {!showRequestPreview && selectedRequestTemplate && (
                  <button
                      onClick={() => setShowRequestPreview(true)}
                      className="requests-preview-edge-toggle"
                      title="Показати превʼю"
                  >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7M19 5v14" />
                      </svg>
                  </button>
              )}
          </div>
      </div>
      )}

      {activeTab === 'warehouseOrders' && (
      <div className="flex-1 bg-slate-950 p-4 md:p-6 overflow-y-auto">
          <div className="max-w-7xl mx-auto space-y-6">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                      <h2 className="text-2xl font-bold text-slate-100">Замовлення (Склад)</h2>
                      <p className="text-sm text-slate-400 mt-1">Всі заявки, сформовані в замовлення, зі статусами виконання.</p>
                  </div>
                  <div className="flex items-center gap-2">
                      {['all', 'new', 'in_progress', 'ready', 'issued', 'rejected'].map((key) => (
                          <button
                              key={`order-filter-${key}`}
                              type="button"
                              onClick={() => setWarehouseOrdersFilter(key)}
                              className={`px-3 py-1.5 rounded-lg border text-xs transition ${warehouseOrdersFilter === key ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                          >
                              {key === 'all' ? 'Всі' : orderStatusMeta[key]?.label || key}
                          </button>
                      ))}
                      <button
                          type="button"
                          onClick={loadWarehouseOrders}
                          className="px-3 py-1.5 rounded-lg border border-slate-600 text-slate-200 hover:bg-slate-700 text-xs"
                      >
                          Оновити
                      </button>
                  </div>
              </div>

              {canManageWarehouseOrders && (
                  <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4 space-y-3">
                      <div className="text-sm font-semibold text-slate-200">Додати вручну (для складу)</div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <div className="md:col-span-2 text-xs text-slate-500 flex items-center px-2">Ручне замовлення без привʼязки до чату</div>
                          <button
                              type="button"
                              onClick={createManualWarehouseOrder}
                              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition"
                          >
                              Додати замовлення
                          </button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <input
                              value={manualWarehouseOrder.projectName}
                              onChange={(e) => setManualWarehouseOrder((prev) => ({ ...prev, projectName: e.target.value }))}
                              placeholder="Проєкт"
                              className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                          />
                          <input
                              value={manualWarehouseOrder.requesterName}
                              onChange={(e) => setManualWarehouseOrder((prev) => ({ ...prev, requesterName: e.target.value }))}
                              placeholder="Заявник (хто подав)"
                              className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                          />
                      </div>
                      <select
                          value={manualWarehouseOrder.requestType || 'issuance'}
                          onChange={(e) => setManualWarehouseOrder((prev) => ({ ...prev, requestType: e.target.value }))}
                          className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                      >
                          <option value="issuance">Тип: Видача</option>
                          <option value="reservation">Тип: Бронь</option>
                      </select>
                      <div className="flex items-center gap-3">
                          <input
                              type="file"
                              onChange={(e) => setManualWarehouseOrderFile(e.target.files?.[0] || null)}
                              className="text-xs text-slate-300"
                          />
                          {manualWarehouseOrderFile && <span className="text-xs text-slate-400 truncate">{manualWarehouseOrderFile.name}</span>}
                      </div>
                      <textarea
                          value={manualWarehouseOrder.messageText}
                          onChange={(e) => setManualWarehouseOrder((prev) => ({ ...prev, messageText: e.target.value }))}
                          placeholder="Опис замовлення"
                          rows={2}
                          className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500 resize-y"
                      />
                  </div>
              )}

              <div className="bg-slate-900 border border-slate-700/50 rounded-2xl overflow-hidden">
                  {warehouseOrdersLoading ? (
                      <div className="p-5 text-slate-400">Завантаження...</div>
                  ) : filteredWarehouseOrders.length === 0 ? (
                      <div className="p-5 text-slate-500">Замовлень поки немає.</div>
                  ) : (
                      <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                              <thead className="bg-slate-800/60 text-slate-300">
                                  <tr>
                                      <th className="text-left px-4 py-3">ID</th>
                                      <th className="text-left px-4 py-3">Проєкт</th>
                                      <th className="text-left px-4 py-3">Заявник</th>
                                      <th className="text-left px-4 py-3">Тип заявки</th>
                                      <th className="text-left px-4 py-3">Зміст</th>
                                      <th className="text-left px-4 py-3">Файл</th>
                                      <th className="text-left px-4 py-3">Статус</th>
                                      <th className="text-left px-4 py-3">Оновлено</th>
                                  </tr>
                              </thead>
                              <tbody>
                                  {filteredWarehouseOrders.map((order) => (
                                      <tr key={`order-row-${order.id}`} className="border-t border-slate-800">
                                          <td className="px-4 py-3 text-slate-200 font-semibold">#{order.id}</td>
                                          <td className="px-4 py-3 text-slate-300">{order.project_name || '—'}</td>
                                          <td className="px-4 py-3 text-slate-300">{order.requester_name || order.created_by_username || '—'}</td>
                                          <td className="px-4 py-3">
                                              <div className={`inline-flex px-2 py-1 rounded-md border text-xs ${orderTypeMeta[order.request_type]?.className || 'bg-slate-700 text-slate-200 border-slate-600'}`}>
                                                  {orderTypeMeta[order.request_type]?.label || 'Видача'}
                                              </div>
                                          </td>
                                          <td className="px-4 py-3 text-slate-300 max-w-[420px]">
                                              <div className="line-clamp-2">{order.message_text || (order.media_path ? '[Медіа]' : '—')}</div>
                                              {(String(order.message_text || '').length > 140 || canManageWarehouseOrders) && (
                                                  <button
                                                      type="button"
                                                      onClick={() => (canManageWarehouseOrders ? openWarehouseOrderEditor(order) : setExpandedOrder(order))}
                                                      className="mt-1 text-xs text-blue-300 hover:underline"
                                                  >
                                                      {canManageWarehouseOrders ? 'Відкрити / Редагувати' : 'Детальніше'}
                                                  </button>
                                              )}
                                          </td>
                                          <td className="px-4 py-3 text-slate-300">
                                              {order.media_path ? (
                                                  <a href={buildUploadUrl(order.media_path)} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline break-all">
                                                      {order.media_name || 'Відкрити файл'}
                                                  </a>
                                              ) : '—'}
                                          </td>
                                          <td className="px-4 py-3">
                                              <div className={`inline-flex px-2 py-1 rounded-md border text-xs ${orderStatusMeta[order.status]?.className || 'bg-slate-700 text-slate-200 border-slate-600'}`}>
                                                  {orderStatusMeta[order.status]?.label || order.status}
                                              </div>
                                              {canManageWarehouseOrders && (
                                                  <div className="mt-2 flex flex-wrap gap-1">
                                                      {['new', 'in_progress', 'ready', 'issued', 'rejected'].map((nextStatus) => (
                                                          <button
                                                              key={`order-${order.id}-status-${nextStatus}`}
                                                              type="button"
                                                              onClick={() => updateWarehouseOrderStatus(order.id, nextStatus)}
                                                              className={`px-2 py-1 rounded border text-[11px] transition ${order.status === nextStatus ? 'border-blue-400 text-blue-300 bg-blue-500/10' : 'border-slate-600 text-slate-300 hover:bg-slate-700'}`}
                                                          >
                                                              {orderStatusMeta[nextStatus]?.label || nextStatus}
                                                          </button>
                                                      ))}
                                                  </div>
                                              )}
                                          </td>
                                          <td className="px-4 py-3 text-slate-400">{order.status_updated_at ? new Date(order.status_updated_at).toLocaleString() : '—'}</td>
                                      </tr>
                                  ))}
                              </tbody>
                          </table>
                      </div>
                  )}
              </div>
          </div>
      </div>
      )}

      {activeTab === 'documentTemplates' && (
      <div className="flex-1 bg-slate-950 p-4 md:p-6 overflow-y-auto">
          <div className="max-w-7xl mx-auto space-y-8">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div>
                      <h2 className="text-3xl font-bold text-slate-100 flex items-center gap-3">
                        <svg className="w-10 h-10 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                        </svg>
                        Бібліотека документів
                      </h2>
                      <p className="text-slate-400 mt-2">Централізована база шаблонів та інструкцій для всієї команди.</p>
                  </div>
              </div>

              {canManageDocuments && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in fade-in slide-in-from-top-4 duration-500">
                    <div className="lg:col-span-1 bg-slate-900/80 border border-slate-700/50 rounded-2xl p-5 space-y-4 backdrop-blur-sm">
                        <div className="text-sm font-semibold text-slate-200">Нова категорія</div>
                        <input value={newDocumentCategory} onChange={(e) => setNewDocumentCategory(e.target.value)} placeholder="Напр. Гарантійні листи" className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500" />
                        <button onClick={handleCreateDocumentCategory} className="w-full px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white transition">Додати категорію</button>

                        <div className="pt-2 border-t border-slate-700/50">
                            <div className="text-xs uppercase tracking-wider text-slate-500 mb-3">Список категорій</div>
                            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                                {sortCategoriesByOrder(documentCategories).map((category, index, ordered) => (
                                    <div key={category.id} className="px-3 py-2 rounded-lg bg-slate-800/40 border border-slate-700 text-sm text-slate-200 flex items-center justify-between gap-2">
                                        <div className="truncate font-medium">{category.name}</div>
                                        <div className="flex items-center gap-1">
                                            <button type="button" onClick={() => handleMoveDocumentCategory(category.id, 'up')} disabled={index === 0} className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:opacity-40">↑</button>
                                            <button type="button" onClick={() => handleMoveDocumentCategory(category.id, 'down')} disabled={index === ordered.length - 1} className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-slate-600 text-slate-200 hover:bg-slate-700 disabled:opacity-40">↓</button>
                                            <button onClick={() => handleDeleteDocumentCategory(category.id)} className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/20 ml-1">×</button>
                                        </div>
                                    </div>
                                ))}
                                {documentCategories.length === 0 && <div className="text-sm text-slate-500">Категорій поки немає</div>}
                            </div>
                        </div>
                    </div>

                    <div className="lg:col-span-2 bg-slate-900/80 border border-slate-700/50 rounded-2xl p-5 space-y-4 backdrop-blur-sm">
                        <div className="text-sm font-semibold text-slate-200">Додати документ до бібліотеки</div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <select value={newDocumentTemplate.categoryId} onChange={(e) => setNewDocumentTemplate((prev) => ({ ...prev, categoryId: e.target.value }))} className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500">
                                <option value="">Оберіть категорію</option>
                                {documentCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                            </select>
                            <input value={newDocumentTemplate.title} onChange={(e) => setNewDocumentTemplate((prev) => ({ ...prev, title: e.target.value }))} placeholder="Назва шаблону" className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500" />
                            <input value={newDocumentTemplate.fileUrl} onChange={(e) => setNewDocumentTemplate((prev) => ({ ...prev, fileUrl: e.target.value }))} placeholder="Посилання на файл (https://...)" className="md:col-span-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500" />
                            <textarea value={newDocumentTemplate.description} onChange={(e) => setNewDocumentTemplate((prev) => ({ ...prev, description: e.target.value }))} placeholder="Короткий опис" className="md:col-span-2 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500 h-20" />
                        </div>
                        <button onClick={handleCreateDocumentTemplate} className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition shadow-lg shadow-emerald-900/20">Опублікувати в бібліотеку</button>
                    </div>
                </div>
              )}

              <div className="space-y-8 pb-12">
                  {loadingDocumentTemplates ? (
                      <div className="flex flex-col items-center justify-center py-20 gap-4">
                          <div className="w-10 h-10 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin"></div>
                          <div className="text-slate-400 font-medium">Завантаження бібліотеки...</div>
                      </div>
                  ) : documentError ? (
                      <div className="bg-red-500/10 border border-red-500/50 p-6 rounded-2xl text-center">
                          <div className="text-red-400 font-medium">{documentError}</div>
                          <button onClick={loadDocumentTemplates} className="mt-3 text-sm text-blue-400 hover:underline">Спробувати ще раз</button>
                      </div>
                  ) : (
                      <div className="space-y-10">
                          {sortCategoriesByOrder(documentCategories).map((category) => {
                              const items = documentTemplates.filter((item) => String(item.category_id) === String(category.id));
                              if (items.length === 0) return null;
                              return (
                                  <div key={`lib-section-${category.id}`} className="space-y-5">
                                      <div className="flex items-center gap-4">
                                          <h3 className="text-xl font-bold text-slate-200">{category.name}</h3>
                                          <div className="h-px flex-1 bg-slate-800/60"></div>
                                          <span className="text-xs font-medium text-slate-500 px-2 py-1 rounded bg-slate-800/50 uppercase tracking-widest">{items.length} файлів</span>
                                      </div>
                                      
                                      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                                          {items.map((item) => (
                                              <div key={item.id} className="group relative bg-slate-900/50 hover:bg-slate-800/50 border border-slate-700/50 hover:border-blue-500/50 rounded-2xl p-5 transition-all duration-300 flex flex-col gap-4 overflow-hidden">
                                                  {/* Decor decoration */}
                                                  <div className="absolute top-0 right-0 p-3 opacity-10 group-hover:opacity-20 transition-opacity">
                                                      <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 3.59L18.41 8H14z" /></svg>
                                                  </div>
                                                  
                                                  <div className="flex-1 space-y-2">
                                                      <div className="flex items-start justify-between gap-3">
                                                          <div className="font-bold text-slate-100 text-lg leading-tight group-hover:text-blue-400 transition-colors">{item.title}</div>
                                                      </div>
                                                      {item.description && (
                                                          <p className="text-sm text-slate-400 line-clamp-2 leading-relaxed">{item.description}</p>
                                                      )}
                                                  </div>

                                                  <div className="flex items-center justify-between pt-2 border-t border-slate-800/50">
                                                      <a 
                                                          href={item.file_url} 
                                                          target="_blank" 
                                                          rel="noreferrer" 
                                                          className="flex items-center gap-2 text-sm font-semibold text-blue-400 hover:text-blue-300 transition-colors"
                                                      >
                                                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                                                          Скачати файл
                                                      </a>
                                                      
                                                      {canManageDocuments && (
                                                          <div className="flex gap-2">
                                                              <button onClick={() => handleStartEditDocumentTemplate(item)} className="p-1.5 text-slate-500 hover:text-amber-400 transition-colors" title="Редагувати">
                                                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                                              </button>
                                                              <button onClick={() => handleDeleteDocumentTemplate(item.id)} className="p-1.5 text-slate-500 hover:text-red-400 transition-colors" title="Видалити">
                                                                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                                              </button>
                                                          </div>
                                                      )}
                                                  </div>
                                              </div>
                                          ))}
                                      </div>
                                  </div>
                              );
                          })}
                          {documentTemplates.length === 0 && (
                              <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                                  <div className="w-20 h-20 rounded-full bg-slate-800/50 flex items-center justify-center text-slate-600">
                                      <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /></svg>
                                  </div>
                                  <div className="text-slate-400 font-medium">У бібліотеці поки немає жодного документа</div>
                              </div>
                          )}
                      </div>
                  )}
              </div>
          </div>
      </div>
      )}


      {activeTab === 'adminUsers' && isSystemAdmin && (
      <div className="flex-1 bg-slate-950 p-4 md:p-6 overflow-y-auto">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-slate-900/80 border border-slate-700/50 rounded-2xl p-4">
                  <h2 className="text-2xl font-bold text-slate-100 mb-4">Користувачі</h2>
                  {loadingAdminUsers ? <div className="text-slate-400">Завантаження...</div> : (
                  <div className="space-y-2">
                      {adminUsers.map((u) => {
                          const isSelected = String(selectedAdminUserId) === String(u.id);
                          return (
                          <div key={u.id} className={`flex items-center justify-between rounded-xl border p-3 transition ${isSelected ? 'border-blue-500/60 bg-blue-500/10' : 'border-slate-700 bg-slate-800/50'}`}>
                              <div>
                                  <div className="text-slate-100 font-medium">{u.username}</div>
                                  <div className="text-xs text-slate-400">id: {u.id} • роль: {u.role}</div>
                              </div>
                              <div className="flex items-center gap-2">
                                  <button onClick={() => setSelectedAdminUserId(String(u.id))} className={`px-3 py-1.5 rounded-lg border transition ${isSelected ? 'border-blue-400 text-blue-200 bg-blue-500/20' : 'border-slate-600 text-slate-200 hover:bg-slate-700'}`}>Доступи</button>
                                  <button onClick={() => handleAdminRoleChange(u.id, u.role === 'admin' ? 'user' : 'admin')} className="px-3 py-1.5 rounded-lg border border-blue-500/40 text-blue-300 hover:bg-blue-500/20">{u.role === 'admin' ? 'Зробити user' : 'Зробити admin'}</button>
                              </div>
                          </div>
                      )})}
                  </div>
                  )}
              </div>
              <div className="bg-slate-900/80 border border-slate-700/50 rounded-2xl p-4">
                  <h3 className="text-lg font-semibold text-slate-100 mb-3">Точкові доступи</h3>
                  <div className="text-xs text-slate-400 mb-3">
                    {selectedAdminUserId
                      ? `Обрано користувача: ${adminUsers.find((u) => String(u.id) === String(selectedAdminUserId))?.username || selectedAdminUserId}`
                      : 'Обери користувача кнопкою "Доступи"'}
                  </div>
                  {selectedAdminUserId ? (
                  <div className="space-y-2 text-sm">
                      {[
                        ['can_manage_documents','Керування документами'],
                        ['can_manage_tags','Керування тегами'],
                        ['can_manage_broadcasts','Керування розсилками'],
                        ['can_manage_requests','Керування заявами'],
                        ['can_manage_warehouse_orders','Керування замовленнями (Склад)']
                      ].map(([key,label]) => (
                        <label key={key} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/40 p-2">
                          <span className="text-slate-200">{label}</span>
                          <input type="checkbox" checked={Boolean(selectedAdminPermissions[key])} onChange={(e)=>handlePermissionToggle(key,e.target.checked)} />
                        </label>
                      ))}
                  </div>
                  ) : <div className="text-slate-500">Користувача не обрано</div>}
              </div>
          </div>
      </div>
      )}

      {activeTab === 'tasks' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative p-4 md:p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold text-slate-200 mb-6 flex items-center gap-3">
              <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5h10M9 12h10M9 19h10M4 6h.01M4 12h.01M4 18h.01" />
              </svg>
              Задачі
          </h2>
          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4 mb-4 space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="inline-flex rounded-xl border border-slate-700 bg-slate-800/60 p-1">
                      <button
                          type="button"
                          onClick={() => setTasksViewTab('today')}
                          className={`px-3 py-1.5 rounded-lg text-sm transition ${tasksViewTab === 'today' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
                      >
                          Сьогодні
                      </button>
                      <button
                          type="button"
                          onClick={() => setTasksViewTab('board')}
                          className={`px-3 py-1.5 rounded-lg text-sm transition ${tasksViewTab === 'board' ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
                      >
                          Дошка
                      </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                      {[
                          { key: 'all', label: 'Усі' },
                          { key: 'today', label: 'Сьогодні' },
                          { key: 'overdue', label: 'Прострочені' },
                          { key: 'high', label: 'Високий пріоритет' },
                          { key: 'no_chat', label: 'Без чату' }
                      ].map((chip) => (
                          <button
                              key={chip.key}
                              type="button"
                              onClick={() => setTaskFilter(chip.key)}
                              className={`text-xs px-2.5 py-1.5 rounded-lg border transition ${taskFilter === chip.key ? 'bg-blue-500/20 border-blue-500/40 text-blue-300' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
                          >
                              {chip.label}
                          </button>
                      ))}
                  </div>
              </div>
              <div className="flex flex-col md:flex-row gap-2">
                  <input
                      type="text"
                      value={quickTaskTitle}
                      onChange={(e) => setQuickTaskTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleQuickCreateTask(); }}
                      placeholder="Швидка задача... (Enter)"
                      className="flex-1 bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                  />
                  <input
                      type="text"
                      value={taskSearch}
                      onChange={(e) => setTaskSearch(e.target.value)}
                      placeholder="Пошук задач..."
                      className="md:w-72 bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                  />
                  <button
                      type="button"
                      onClick={handleQuickCreateTask}
                      disabled={!quickTaskTitle.trim()}
                      className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition"
                  >
                      Додати
                  </button>
              </div>

              <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3 space-y-3">
                  <div className="text-sm font-semibold text-slate-200">Додавання задачі</div>
                  <input
                      type="text"
                      value={taskDraft.title}
                      onChange={(e) => setTaskDraft((prev) => ({ ...prev, title: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTask(); }}
                      autoComplete="off"
                      placeholder="Назва задачі"
                      className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                  />
                  <textarea
                      value={taskDraft.description}
                      onChange={(e) => setTaskDraft((prev) => ({ ...prev, description: e.target.value }))}
                      rows={2}
                      placeholder="Опис (необов’язково)"
                      className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition resize-y"
                  />
                  <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                      <input
                          type="date"
                          value={taskDraft.planDate}
                          onChange={(e) => setTaskDraft((prev) => ({ ...prev, planDate: e.target.value }))}
                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                      />
                      <input
                          type="date"
                          value={taskDraft.dueDate}
                          onChange={(e) => setTaskDraft((prev) => ({ ...prev, dueDate: e.target.value }))}
                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                      />
                      <select
                          value={taskDraft.priority}
                          onChange={(e) => setTaskDraft((prev) => ({ ...prev, priority: e.target.value }))}
                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                      >
                          <option value="low">Низький</option>
                          <option value="medium">Середній</option>
                          <option value="high">Високий</option>
                      </select>
                      <select
                          value={taskDraft.status}
                          onChange={(e) => setTaskDraft((prev) => ({ ...prev, status: e.target.value }))}
                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                      >
                          <option value="plan">План</option>
                          <option value="in_progress">В роботі</option>
                          <option value="done">Готово</option>
                      </select>
                      <select
                          value={taskDraft.chatId}
                          onChange={(e) => setTaskDraft((prev) => ({ ...prev, chatId: e.target.value }))}
                          className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                      >
                          <option value="">Без чату</option>
                          {dialogs.map((dialog) => (
                              <option key={`task-form-dialog-${dialog.id}`} value={String(dialog.id)}>{dialog.name}</option>
                          ))}
                      </select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                      <button
                          type="button"
                          onClick={handleCreateTask}
                          disabled={!taskDraft.title.trim()}
                          className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white transition"
                      >
                          Додати задачу
                      </button>
                      <button
                          type="button"
                          onClick={() => setTaskDraft((prev) => ({ ...prev, title: '', description: '' }))}
                          className="px-4 py-2 rounded-xl border border-slate-600 text-slate-300 hover:bg-slate-700 transition"
                      >
                          Очистити текст
                      </button>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                      <div className="text-sm font-semibold text-slate-200 mb-2">Щоденний дайджест у Telegram</div>
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                          <label className="flex items-center gap-2 text-sm text-slate-300 md:col-span-1">
                              <input
                                  type="checkbox"
                                  checked={!!taskReminderSettings.enabled}
                                  onChange={(e) => setTaskReminderSettings((prev) => ({ ...prev, enabled: e.target.checked }))}
                                  className="accent-blue-500"
                              />
                              Увімкнено
                          </label>
                          <input
                              type="time"
                              value={taskReminderSettings.time || '09:00'}
                              onChange={(e) => setTaskReminderSettings((prev) => ({ ...prev, time: e.target.value }))}
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                          />
                          <label className="flex items-center gap-2 text-sm text-slate-300 md:col-span-2">
                              <input
                                  type="checkbox"
                                  checked={!!taskBotSettings.enabled}
                                  onChange={(e) => setTaskBotSettings((prev) => ({ ...prev, enabled: e.target.checked }))}
                                  className="accent-blue-500"
                              />
                              Бот-надсилання увімкнено
                          </label>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
                          <input
                              type="password"
                              value={taskBotTokenDraft}
                              onChange={(e) => setTaskBotTokenDraft(e.target.value)}
                              autoComplete="new-password"
                              placeholder={taskBotSettings.hasToken ? 'Token збережено (введи новий тільки якщо змінюєш)' : 'Bot Token'}
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition md:col-span-2"
                          />
                          <input
                              type="text"
                              value={taskBotChatIdDraft}
                              onChange={(e) => setTaskBotChatIdDraft(e.target.value)}
                              autoComplete="off"
                              placeholder="Chat ID (ваш Telegram id)"
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                          />
                      </div>
                      <div className="flex flex-wrap gap-2 mt-2">
                          <button
                              type="button"
                              onClick={saveTaskBotSettings}
                              className="px-3 py-2 rounded-xl border border-blue-500/40 text-blue-300 hover:bg-blue-500/10 transition"
                          >
                              Зберегти бота
                          </button>
                          <button
                              type="button"
                              onClick={sendTaskBotTest}
                              className="px-3 py-2 rounded-xl border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 transition"
                          >
                              Тест повідомлення
                          </button>
                      </div>
                      <div className="text-xs text-slate-400 mt-2">
                          Щодня у вибраний час надішлеться список задач із блоку “Сьогодні”. Одноразові нагадування задач також ідуть через цього бота.
                      </div>
                      <div className="text-xs text-slate-500 mt-1 leading-5">
                          Як увімкнути: 1) створи бота в @BotFather (отримаєш Bot Token), 2) зі свого Telegram напиши цьому боту `/start`, 3) отримай свій Telegram ID через @userinfobot, 4) встав Token та Chat ID тут, 5) натисни “Зберегти бота”, 6) натисни “Тест повідомлення”.<br />
                          Важливо: у кожного користувача мають бути свої Token+Chat ID, інакше нагадування підуть не туди.
                      </div>
                  </div>
                  <div className="pt-1">
                      <div className="text-xs text-slate-400 mb-1">Масове внесення: кожен рядок — окрема задача</div>
                      <textarea
                          value={bulkTaskText}
                          onChange={(e) => setBulkTaskText(e.target.value)}
                          rows={3}
                          placeholder={"Приклад:\nПодзвонити постачальнику\nУточнити рахунок\nПідготувати КП"}
                          className="w-full bg-slate-900/70 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition resize-y"
                      />
                      <div className="mt-2">
                          <button
                              type="button"
                              onClick={handleCreateTasksFromLines}
                              disabled={!bulkTaskText.trim()}
                              className="px-3 py-2 rounded-xl border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 disabled:opacity-50 transition"
                          >
                              Додати списком
                          </button>
                      </div>
                  </div>
              </div>
          </div>

          <div className="grid grid-cols-1 2xl:grid-cols-[minmax(0,1fr)_340px] gap-4">
              <div className="min-w-0 space-y-4">
                  {tasksViewTab === 'today' ? (
                      <>
                          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4">
                              <div className="text-sm font-semibold text-slate-100 mb-3">Top-3 фокус</div>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                  {topFocusTasks.length === 0 && <div className="text-sm text-slate-500 md:col-span-3">Немає активних задач.</div>}
                                  {topFocusTasks.map((task) => (
                                      <button key={`focus-${task.id}`} type="button" onClick={() => setSelectedTaskId(task.id)} className="text-left rounded-xl border border-slate-700 bg-slate-800/60 p-3 hover:border-blue-500/40 transition">
                                          <div className="text-sm font-medium text-slate-100 truncate">{task.title}</div>
                                          <div className="text-xs text-slate-400 mt-1">{task.dueDate ? `Дедлайн: ${task.dueDate}` : 'Без дедлайну'}</div>
                                      </button>
                                  ))}
                              </div>
                          </div>

                          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4">
                              <div className="text-sm font-semibold text-slate-100 mb-3">Сьогодні</div>
                              <div className="space-y-2">
                                  {todayPlannerTasks.length === 0 && <div className="text-sm text-slate-500">Порожньо</div>}
                                  {todayPlannerTasks.map((task) => (
                                      <div key={`today-${task.id}`} className={`rounded-xl border p-3 transition ${selectedTaskId === task.id ? 'border-blue-500/40 bg-blue-500/10' : 'border-slate-700 bg-slate-800/50'}`}>
                                          <div className="flex items-center justify-between gap-2">
                                              <button type="button" onClick={() => setSelectedTaskId(task.id)} className={`text-left text-sm font-medium ${task.status === 'done' ? 'text-slate-500 line-through' : 'text-slate-100'}`}>
                                                  {task.title}
                                              </button>
                                              <div className="flex items-center gap-1.5">
                                                  {task.status !== 'done' && <button type="button" onClick={() => handleTaskStatusChange(task.id, 'done')} className="text-[11px] px-2 py-1 rounded-md border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 transition">Готово</button>}
                                                  {task.status !== 'in_progress' && <button type="button" onClick={() => handleTaskStatusChange(task.id, 'in_progress')} className="text-[11px] px-2 py-1 rounded-md border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 transition">В роботу</button>}
                                                  <button type="button" onClick={() => handleTaskMoveToTomorrow(task.id)} className="text-[11px] px-2 py-1 rounded-md border border-slate-600 text-slate-300 hover:bg-slate-700 transition">На завтра</button>
                                              </div>
                                          </div>
                                      </div>
                                  ))}
                              </div>
                          </div>

                          {overdueTasks.length > 0 && (
                              <div className="bg-slate-900 border border-red-500/20 rounded-2xl p-4">
                                  <div className="text-sm font-semibold text-red-300 mb-2">Прострочені</div>
                                  <div className="space-y-2">
                                      {overdueTasks.map((task) => (
                                          <button key={`overdue-${task.id}`} type="button" onClick={() => setSelectedTaskId(task.id)} className="w-full text-left rounded-xl border border-red-500/20 bg-red-500/5 p-3 hover:bg-red-500/10 transition">
                                              <div className="text-sm text-slate-100">{task.title}</div>
                                              <div className="text-xs text-red-300 mt-1">Дедлайн: {task.dueDate}</div>
                                          </button>
                                      ))}
                                  </div>
                              </div>
                          )}

                          {movedToTomorrowTasks.length > 0 && (
                              <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4">
                                  <div className="text-sm font-semibold text-slate-100 mb-2">Перенесено на завтра</div>
                                  <div className="flex flex-wrap gap-2">
                                      {movedToTomorrowTasks.map((task) => (
                                          <span key={`moved-${task.id}`} className="text-xs px-2 py-1 rounded-lg border border-slate-600 text-slate-300 bg-slate-800/50">
                                              {task.title}
                                          </span>
                                      ))}
                                  </div>
                              </div>
                          )}

                          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4">
                              <div className="text-sm font-semibold text-slate-100 mb-2">Нотатки дня</div>
                              <textarea
                                  value={todayTaskNote}
                                  onChange={(e) => setTaskDailyNotesByDate((prev) => ({ ...prev, [todayTaskDate]: e.target.value }))}
                                  rows={4}
                                  placeholder="Короткий план / думки на день..."
                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition resize-y"
                              />
                          </div>
                      </>
                  ) : (
                      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                          {['plan', 'in_progress', 'done'].map((statusKey) => (
                              <div key={statusKey} className="bg-slate-900 border border-slate-700/50 rounded-2xl p-3 min-h-[420px] flex flex-col">
                                  <div className="flex items-center justify-between mb-3">
                                      <div className="text-sm font-semibold text-slate-100">{taskStatusMeta[statusKey].label}</div>
                                      <span className="text-xs px-2 py-0.5 rounded-full border border-slate-600 text-slate-300">{tasksByStatus[statusKey].length}</span>
                                  </div>
                                  <div className="space-y-2 overflow-y-auto pr-1">
                                      {tasksByStatus[statusKey].length === 0 && <div className="text-xs text-slate-500">Порожньо</div>}
                                      {tasksByStatus[statusKey].map((task) => (
                                          <button key={task.id} type="button" onClick={() => setSelectedTaskId(task.id)} className={`w-full text-left rounded-xl border p-3 transition ${selectedTaskId === task.id ? 'border-blue-500/40 bg-blue-500/10' : 'border-slate-700 bg-slate-800/50 hover:bg-slate-700/50'}`}>
                                              <div className="text-sm font-medium text-slate-100">{task.title}</div>
                                              {task.description && <div className="text-xs text-slate-400 mt-1 line-clamp-2">{task.description}</div>}
                                          </button>
                                      ))}
                                  </div>
                              </div>
                          ))}
                      </div>
                  )}
              </div>

              <div className="bg-slate-900 border border-slate-700/50 rounded-2xl p-4 h-fit 2xl:sticky 2xl:top-6">
                  {!selectedTask ? (
                      <div className="text-sm text-slate-500">Оберіть задачу, щоб редагувати деталі.</div>
                  ) : (
                      <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                              <div className="text-sm font-semibold text-slate-100">Деталі задачі</div>
                              <button type="button" onClick={() => handleTaskDelete(selectedTask.id)} className="text-xs px-2 py-1 rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10 transition">Видалити</button>
                          </div>
                          <input
                              type="text"
                              value={selectedTask.title || ''}
                              onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { title: e.target.value })}
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                          />
                          <textarea
                              value={selectedTask.description || ''}
                              onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { description: e.target.value })}
                              rows={4}
                              placeholder="Опис"
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition resize-y"
                          />
                          <div className="grid grid-cols-2 gap-2">
                              <input type="date" value={selectedTask.planDate || ''} onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { planDate: e.target.value })} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition" />
                              <input type="date" value={selectedTask.dueDate || ''} onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { dueDate: e.target.value })} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition" />
                          </div>
                          <div>
                              <label className="block text-xs text-slate-400 mb-1">Одноразове нагадування (Telegram)</label>
                              <input
                                  type="datetime-local"
                                  value={selectedTask.reminderAt || ''}
                                  onChange={(e) => handleTaskFieldUpdate(selectedTask.id, {
                                      reminderAt: e.target.value,
                                      reminderSentAt: ''
                                  })}
                                  className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                              />
                              <select
                                  value={selectedTask.reminderRepeat || 'none'}
                                  onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { reminderRepeat: e.target.value })}
                                  className="w-full mt-2 bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                              >
                                  <option value="none">Без повтору</option>
                                  <option value="daily">Щодня</option>
                                  <option value="weekly">Щотижня</option>
                              </select>
                              {selectedTask.reminderSentAt && (
                                  <div className="text-[11px] text-emerald-300 mt-1">
                                      Нагадування надіслано: {new Date(selectedTask.reminderSentAt).toLocaleString()}
                                  </div>
                              )}
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                              <select value={selectedTask.priority || 'medium'} onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { priority: e.target.value })} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition">
                                  <option value="low">Низький</option>
                                  <option value="medium">Середній</option>
                                  <option value="high">Високий</option>
                              </select>
                              <select value={selectedTask.status || 'plan'} onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { status: e.target.value })} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition">
                                  <option value="plan">План</option>
                                  <option value="in_progress">В роботі</option>
                                  <option value="done">Готово</option>
                              </select>
                          </div>
                          <select
                              value={selectedTask.chatId || ''}
                              onChange={(e) => handleTaskFieldUpdate(selectedTask.id, { chatId: e.target.value })}
                              className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-3 py-2 outline-none focus:border-blue-500 transition"
                          >
                              <option value="">Без привʼязки до чату</option>
                              {dialogs.map((dialog) => (
                                  <option key={`drawer-task-dialog-${dialog.id}`} value={String(dialog.id)}>{dialog.name}</option>
                              ))}
                          </select>
                          {selectedTask.chatId && (
                              <button
                                  type="button"
                                  onClick={() => {
                                      const matched = dialogs.find((dialog) => String(dialog.id) === String(selectedTask.chatId));
                                      if (matched) {
                                          setSelectedDialog(matched);
                                          setActiveTab('messenger');
                                      }
                                  }}
                                  className="w-full text-sm px-3 py-2 rounded-xl border border-blue-500/30 text-blue-300 hover:bg-blue-500/10 transition"
                              >
                                  Відкрити привʼязаний чат
                              </button>
                          )}
                      </div>
                  )}
              </div>
          </div>
      </div>
      )}

      {/* CRM Base Area */}
      {activeTab === 'crm' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold text-slate-200 mb-6 flex items-center gap-3">
              <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              База CRM (Контакти)
          </h2>

          <div className="bg-slate-900 border border-slate-700/50 rounded-2xl shadow-xl flex flex-col flex-1 min-h-0 overflow-hidden">
              <div className="p-4 border-b border-slate-700/50 flex justify-between items-center bg-slate-800/50 shrink-0">
                  <input
                      type="text"
                      placeholder="Знайти контакт..."
                      value={contactSearchQuery}
                      onChange={(e) => setContactSearchQuery(e.target.value)}
                      className="bg-slate-800 text-sm border border-slate-700 rounded-lg px-4 py-2 outline-none focus:border-blue-500 transition w-64"
                  />
                  <span className="text-slate-400 text-sm">Всього: {contacts.length}</span>
              </div>

              {loadingContacts ? (
                  <div className="p-10 text-center text-slate-400 animate-pulse">Завантаження контактів із Telegram...</div>
              ) : (
              <div className="flex-1 overflow-y-auto min-h-0 relative">
                  <table className="w-full text-left border-collapse">
                      <thead className="sticky top-0 z-10">
                          <tr className="bg-slate-800/95 backdrop-blur-sm text-slate-400 text-sm uppercase tracking-wider shadow-sm">
                              <th className="p-4 font-medium">Клієнт</th>
                              <th className="p-4 font-medium">Телефон</th>
                              <th className="p-4 font-medium">Username</th>
                              <th className="p-4 font-medium text-right">Дія</th>
                          </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-700/50">
                          {contacts.filter(c =>
                             !contactSearchQuery ||
                             c.firstName?.toLowerCase().includes(contactSearchQuery.toLowerCase()) ||
                             c.lastName?.toLowerCase().includes(contactSearchQuery.toLowerCase()) ||
                             c.username?.toLowerCase().includes(contactSearchQuery.toLowerCase()) ||
                             c.phone?.includes(contactSearchQuery)
                          ).map(contact => (
                              <tr key={contact.id} className="hover:bg-slate-800/30 transition">
                                  <td className="p-4">
                                      <div className="font-semibold text-slate-200">{contact.firstName} {contact.lastName}</div>
                                  </td>
                                  <td className="p-4 text-slate-300">{contact.phone ? `+${contact.phone}` : '-'}</td>
                                  <td className="p-4 text-slate-400">{contact.username ? `@${contact.username}` : '-'}</td>
                                  <td className="p-4 text-right">
                                      <div className="flex justify-end gap-2">
                                          <button
                                              onClick={() => handleOpenContactProfile(contact)}
                                              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition text-sm font-medium border border-slate-700"
                                          >
                                              Профіль
                                          </button>
                                          <button
                                              onClick={() => openChatById(contact.id)}
                                              className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white rounded-lg transition text-sm font-medium"
                                          >
                                              Написати
                                          </button>
                                          <button
                                              onClick={() => handleSendCrmContact(contact)}
                                              className="px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white rounded-lg transition text-sm font-medium"
                                          >
                                              Надіслати контакт
                                          </button>
                                      </div>
                                  </td>
                              </tr>
                          ))}
                          {contacts.length === 0 && (
                              <tr>
                                  <td colSpan="4" className="p-8 text-center text-slate-500">Контактів не знайдено</td>
                              </tr>
                          )}
                      </tbody>
                  </table>
              </div>
              )}
          </div>
      </div>
      )}

      {/* Bulk Area (Розсилки) */}
      {activeTab === 'bulk' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold text-slate-200 mb-6 flex items-center gap-3">
              <svg className="w-8 h-8 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z" />
              </svg>
              Масова Розсилка
          </h2>
          <div className="max-w-2xl bg-slate-900 border border-slate-700/50 rounded-2xl shadow-xl p-6">
              <p className="text-slate-400 mb-4 text-sm">Цей модуль дозволяє відправляти повідомлення вибраній аудиторії (по тегам) з безпечною затримкою.</p>
              
              <div className="space-y-4">
                  <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Цільова аудиторія (Теги)</label>
                      <select value={bulkTagId} onChange={e => setBulkTagId(e.target.value)} className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-2 outline-none focus:border-blue-500">
                          <option value="">Всі контакти</option>
                          {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                  </div>
                  <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1">Текст повідомлення</label>
                      <textarea value={bulkMessage} onChange={e => setBulkMessage(e.target.value)} rows="5" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 resize-none" placeholder="Введіть текст розсилки..."></textarea>
                  </div>
                  <div className="flex items-end pt-2">
                      <button onClick={handleBulkSendInitial} disabled={bulkLoading || !bulkMessage.trim()} className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-lg rounded-xl transition shadow-lg shadow-blue-500/20 flex items-center justify-center">
                          Готувати розсилку
                      </button>
                  </div>
                  
                  {/* Повідомлення про помилки або успіх */}
                  {bulkError && <div className="mt-4 p-3 bg-red-500/10 border border-red-500/50 rounded-xl text-red-400 text-sm font-medium flex items-center gap-2">
                       <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                       {bulkError}
                  </div>}
                  
                  {bulkResult && <div className="mt-4 p-3 bg-green-500/10 border border-green-500/50 rounded-xl text-green-400 text-sm font-medium flex items-center gap-2">
                      <svg className="w-5 h-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      {bulkResult}
                  </div>}
                  
                  {/* Внутрішнє вікно підтвердження */}
                  {bulkConfirmTargets && (
                     <div className="mt-6 p-5 bg-yellow-500/10 border border-yellow-500/40 rounded-2xl flex flex-col items-center">
                         <div className="w-12 h-12 bg-yellow-500/20 text-yellow-500 rounded-full flex items-center justify-center mb-3">
                             <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                         </div>
                         <h3 className="text-lg font-bold text-slate-200 mb-1">Остаточне підтвердження</h3>
                         <p className="text-slate-400 text-sm mb-4 text-center">Ви збираєтесь відправити це повідомлення <strong>{bulkConfirmTargets.length}</strong> контактам. Зворотнього шляху не буде!</p>
                         
                         <div className="flex gap-3 w-full max-w-xs">
                             <button onClick={() => setBulkConfirmTargets(null)} className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl transition font-medium">
                                 Скасувати
                             </button>
                             <button onClick={executeBulkSend} className="flex-1 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded-xl transition font-medium shadow-lg shadow-yellow-600/20 flex justify-center items-center">
                                 {bulkLoading ? 'Запуск...' : '🚀 Підтвердити'}
                             </button>
                         </div>
                     </div>
                  )}
              </div>
          </div>
      </div>
      )}

      {/* Saved Notes Tab */}
      {activeTab === 'savedNotes' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold text-slate-200 mb-6 flex items-center gap-3">
              <svg className="w-8 h-8 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              Збережені Нотатки
          </h2>
          {loadingSaved ? <div className="text-center text-slate-400">Завантаження...</div> : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {savedMessagesList.length === 0 && <p className="text-slate-500 col-span-full text-center py-10">Тут будуть збережені повідомлення з вашими коментарями.</p>}
                  {savedMessagesList.map(note => {
                      const chatName = dialogs.find(d => String(d.id) === String(note.chat_id))?.name || 'Невідомий чат';
                      return (
                          <div key={note.id} className="bg-slate-900 border border-slate-700 rounded-2xl p-4 flex flex-col shadow-lg">
                              <div className="flex justify-between items-start mb-3 border-b border-slate-800 pb-2">
                                  <div className="flex flex-col">
                                      <span className="text-sm font-semibold text-blue-400 truncate">{chatName}</span>
                                      <span className="text-[10px] text-slate-500">{new Date(note.created_at).toLocaleString()}</span>
                                  </div>
                                  <button onClick={() => handleDeleteSavedMessage(note.id)} className="p-1 hover:bg-red-500/10 text-red-400 rounded transition">
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                  </button>
                              </div>
                              {note.comment && (
                                  <div className="mb-3 bg-yellow-500/10 border-l-2 border-yellow-500 p-2 text-sm text-yellow-200">
                                      <strong>Коментар: </strong>{note.comment}
                                  </div>
                              )}
                              <div className="text-sm text-slate-300 italic mb-4 line-clamp-4 flex-1">
                                  {note.media_path && <span className="block text-xs text-blue-300 mb-1">[Вкладення]</span>}
                                  {note.message_text}
                              </div>
                              <button onClick={() => {
                                  openChatById(note.chat_id, { focusMessageId: note.message_id });
                              }} className="w-full mt-auto py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition text-sm font-medium border border-slate-700">
                                  Відкрити чат
                              </button>
                          </div>
                      );
                  })}
              </div>
          )}
      </div>
      )}

      {/* All Comments/Notes Tab */}
      {activeTab === 'comments' && (
      <div className="flex-1 flex flex-col bg-[#0b101e] relative p-6 overflow-y-auto">
          <h2 className="text-2xl font-bold text-slate-200 mb-6 flex items-center gap-3">
              <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              Всі Коментарі
          </h2>
          {loadingAllNotes ? <div className="text-center text-slate-400">Завантаження...</div> : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {allChatNotes.length === 0 && <p className="text-slate-500 col-span-full text-center py-10">Коментарів ще немає. Ви можете додавати їх до чатів.</p>}
                  {allChatNotes.map(note => {
                      const matchedDialog = dialogs.find(d => String(d.id) === String(note.chat_id)) || contacts.find(c => String(c.id) === String(note.chat_id));
                      const chatName = matchedDialog ? (matchedDialog.name || `${matchedDialog.firstName||''} ${matchedDialog.lastName||''}`) : 'Невідомий чат ' + note.chat_id;
                      return (
                          <div key={note.chat_id} className="bg-slate-900 border border-slate-700 rounded-2xl p-4 flex flex-col shadow-lg">
                              <div className="flex justify-between items-start mb-3 border-b border-slate-800 pb-2">
                                  <div className="flex flex-col">
                                      <span className="text-sm font-semibold text-blue-400 truncate">{chatName}</span>
                                      <span className="text-[10px] text-slate-500">{new Date(note.updated_at).toLocaleString()}</span>
                                  </div>
                                  <button onClick={() => handleDeleteChatNote(note.chat_id)} className="p-1 hover:bg-red-500/10 text-red-400 rounded transition">
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                  </button>
                              </div>
                              <div className="mb-4 text-sm text-slate-200 flex-1 whitespace-pre-wrap">
                                  {note.content}
                              </div>
                              <button onClick={() => {
                                  openChatById(note.chat_id, { focusMessageId: note.anchor_message_id });
                              }} className="w-full mt-auto py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition text-sm font-medium border border-slate-700">
                                  Відкрити чат
                              </button>
                          </div>
                      );
                  })}
              </div>
          )}
      </div>
      )}

      {/* Modals & Overlays */}

      {/* Fullscreen Image Lightbox */}
      {fullscreenImage && (
          <div className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm flex items-center justify-center" onClick={() => setFullscreenImage(null)}>
              <button className="absolute top-6 right-6 text-white/50 hover:text-white bg-black/50 p-2 rounded-full transition">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
              <img src={fullscreenImage} className="max-w-[95vw] max-h-[95vh] object-contain cursor-default" onClick={e => e.stopPropagation()} alt="fullscreen" />
          </div>
      )}

      {/* Chat General Note Modal */}
      {showChatNoteModal && selectedDialog && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative">
                  <button onClick={() => setShowChatNoteModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-2">Коментарі до чату: {selectedDialog.name}</h3>
                  <p className="text-sm text-slate-400 mb-4">Ці коментарі закріплені за усім чатом.</p>
                  <textarea value={chatNoteText} onChange={e => setChatNoteText(e.target.value)} rows="6" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-blue-500 resize-none" placeholder="Пишіть свої коментарі тут..."></textarea>
                  <button onClick={handleSaveChatNote} className="w-full mt-4 py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-xl transition shadow-lg shadow-blue-500/20">
                      Зберегти коментарі
                  </button>
              </div>
          </div>
      )}

      {/* Save Message Note Modal */}
      {showSaveMessageModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col">
                  <button onClick={() => setShowSaveMessageModal(null)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
                       <svg className="w-5 h-5 text-yellow-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" /></svg>
                       В збережені нотатки
                  </h3>
                  <div className="bg-slate-800/50 p-3 rounded-lg border border-slate-700 mb-4 max-h-32 overflow-y-auto text-sm text-slate-300 italic">
                      "{showSaveMessageModal.text || 'Повідомлення без тексту (Медіа)'}"
                  </div>
                  <textarea value={messageNoteComment} onChange={e => setMessageNoteComment(e.target.value)} rows="3" className="w-full bg-slate-800 text-slate-200 border border-slate-700 rounded-xl px-4 py-3 outline-none focus:border-yellow-500 resize-none" placeholder="Додайте свій коментар або тег сюди..."></textarea>
                  <button onClick={handleSaveMessageNote} className="w-full mt-4 py-3 bg-yellow-600 hover:bg-yellow-500 text-white font-medium rounded-xl transition shadow-lg shadow-yellow-500/20">
                      Зберегти
                  </button>
              </div>
          </div>
      )}

      {expandedOrder && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-2xl p-6 relative">
                  <button onClick={() => { setExpandedOrder(null); setEditingWarehouseOrder(null); setEditingWarehouseOrderFile(null); }} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-3">Замовлення #{expandedOrder.id}</h3>
                  {canManageWarehouseOrders && editingWarehouseOrder?.id === expandedOrder.id ? (
                      <div className="space-y-3">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                              <input
                                  value={editingWarehouseOrder.projectName}
                                  onChange={(e) => setEditingWarehouseOrder((prev) => ({ ...prev, projectName: e.target.value }))}
                                  placeholder="Проєкт"
                                  className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                              />
                              <input
                                  value={editingWarehouseOrder.requesterName}
                                  onChange={(e) => setEditingWarehouseOrder((prev) => ({ ...prev, requesterName: e.target.value }))}
                                  placeholder="Заявник"
                                  className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                              />
                          </div>
                          <select
                              value={editingWarehouseOrder.requestType || 'issuance'}
                              onChange={(e) => setEditingWarehouseOrder((prev) => ({ ...prev, requestType: e.target.value }))}
                              className="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500"
                          >
                              <option value="issuance">Тип: Видача</option>
                              <option value="reservation">Тип: Бронь</option>
                          </select>
                          <textarea
                              value={editingWarehouseOrder.messageText}
                              onChange={(e) => setEditingWarehouseOrder((prev) => ({ ...prev, messageText: e.target.value }))}
                              rows={8}
                              className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-slate-100 outline-none focus:border-blue-500 resize-y"
                          />
                          <div className="flex items-center gap-3">
                              <input
                                  type="file"
                                  onChange={(e) => setEditingWarehouseOrderFile(e.target.files?.[0] || null)}
                                  className="text-xs text-slate-300"
                              />
                              {editingWarehouseOrderFile && <span className="text-xs text-slate-400 truncate">{editingWarehouseOrderFile.name}</span>}
                          </div>
                          <div className="flex flex-wrap items-center gap-3">
                              <button
                                  type="button"
                                  onClick={saveWarehouseOrderEdits}
                                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white transition"
                              >
                                  Зберегти правки
                              </button>
                              {expandedOrder.media_path && (
                                  <a
                                      href={buildUploadUrl(expandedOrder.media_path)}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-blue-300 hover:underline text-sm"
                                  >
                                      Поточне вкладення: {expandedOrder.media_name || 'файл'}
                                  </a>
                              )}
                          </div>
                      </div>
                  ) : (
                      <>
                          <div className="grid grid-cols-2 gap-3 text-sm mb-4">
                              <div className="text-slate-300">Проєкт: <span className="text-slate-100">{expandedOrder.project_name || '—'}</span></div>
                              <div className="text-slate-300">Заявник: <span className="text-slate-100">{expandedOrder.requester_name || expandedOrder.created_by_username || '—'}</span></div>
                              <div className="text-slate-300">Тип заявки: <span className="text-slate-100">{orderTypeMeta[expandedOrder.request_type]?.label || 'Видача'}</span></div>
                          </div>
                          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 max-h-[50vh] overflow-y-auto whitespace-pre-wrap text-slate-200 text-sm">
                              {expandedOrder.message_text || 'Без тексту'}
                          </div>
                          {expandedOrder.media_path && (
                              <a
                                  href={buildUploadUrl(expandedOrder.media_path)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex mt-4 text-blue-300 hover:underline text-sm"
                              >
                                  Відкрити вкладення: {expandedOrder.media_name || 'файл'}
                              </a>
                          )}
                      </>
                  )}
              </div>
          </div>
      )}

      {/* Forward Modal */}
      {showForwardModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => { setShowForwardModal(null); setForwardSearchQuery(''); }} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">
                      Кому переслати? ({Array.isArray(showForwardModal?.messageIds) ? showForwardModal.messageIds.length : 0})
                  </h3>
                  <input type="text" placeholder="Пошук чату..." value={forwardSearchQuery} onChange={(e) => setForwardSearchQuery(e.target.value)} className="w-full bg-slate-800 text-sm border border-slate-700 rounded-lg px-4 py-2 mb-4 outline-none focus:border-blue-500 transition" />
                  
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2 scrollbar-hide">
                      {dialogs.filter(d => !forwardSearchQuery || d.name.toLowerCase().includes(forwardSearchQuery.toLowerCase()))
                          .slice(0, 50).map(chat => (
                              <div key={chat.id} onClick={() => handleForwardMessage(chat.id)} className="flex items-center gap-3 bg-slate-800/50 p-2 rounded-lg border border-slate-700/50 hover:bg-slate-800 transition cursor-pointer">
                                  <div className="w-10 h-10 rounded-full bg-slate-700 text-blue-400 flex items-center justify-center font-bold shrink-0 text-sm">
                                      {(chat.name || "?").charAt(0)}
                                  </div>
                                  <div className="flex flex-col truncate">
                                      <span className="text-sm font-medium text-slate-200 truncate">{chat.name}</span>
                                      <span className="text-xs text-slate-500">{chat.isGroup ? 'Група' : chat.isChannel ? 'Канал' : 'Користувач'}</span>
                                  </div>
                              </div>
                          ))
                      }
                  </div>
              </div>
          </div>
      )}

      {/* Folders Manager Area */}
      {activeTab === 'foldersManager' && (
      <div className="flex-1 flex bg-[#0b101e] h-screen overflow-hidden">
          {/* Left Sidebar: Folders List */}
          <div className="w-1/3 min-w-[300px] border-r border-slate-700 flex flex-col h-full bg-slate-900 overflow-y-auto">
             <div className="p-4 border-b border-slate-700/50 sticky top-0 bg-slate-900/80 backdrop-blur z-10 flex flex-col gap-3">
                 <h2 className="text-xl font-bold text-slate-200">Ваші Папки (Telegram)</h2>
                 <button onClick={() => {
                     const newFolder = {
                         id: Math.floor(Math.random() * 100) + 10,
                         title: 'Нова папка',
                         contacts: false, nonContacts: false, groups: false, broadcasts: false, bots: false,
                         excludeMuted: false, includePeers: [], excludePeers: []
                     };
                     setFolders(prev => [newFolder, ...prev]);
                     setSelectedFolderForManage(newFolder);
                 }} className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition shadow-lg shadow-blue-500/20">
                     Створити нову папку
                 </button>
             </div>
             <div className="p-4 space-y-2">
                 {folders.length === 0 && <p className="text-slate-500 text-sm text-center py-4">Немає папок</p>}
                 {folders.map(folder => (
                     <div key={folder.id} 
                          onClick={() => setSelectedFolderForManage({...folder, includePeers: folder.includePeers || []})}
                          className={`p-3 rounded-xl border transition cursor-pointer flex items-center gap-3 ${selectedFolderForManage?.id === folder.id ? 'bg-blue-500/10 border-blue-500/50' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'}`}>
                          <svg className="w-5 h-5 shrink-0 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                          <span className="font-medium text-slate-200 truncate flex-1">{folder.title || folder.name}</span>
                     </div>
                 ))}
             </div>
          </div>
          
          {/* Right Panel: Manage Selected Folder */}
          <div className="flex-1 bg-[#0b101e] h-full flex flex-col overflow-y-auto hidden md:flex relative p-6">
             {selectedFolderForManage ? (
                 <div className="max-w-3xl flex flex-col gap-6">
                     <div className="flex items-center justify-between pb-4 border-b border-slate-700/50">
                         <div className="flex items-end gap-3 flex-1">
                             <input type="text" value={selectedFolderForManage.title || selectedFolderForManage.name || ''} onChange={e => setSelectedFolderForManage({...selectedFolderForManage, title: e.target.value})} className="bg-transparent text-2xl font-bold text-slate-200 outline-none border-b border-transparent focus:border-blue-500 transition px-1 flex-1" placeholder="Назва папки..." />
                         </div>
                         <div className="flex items-center gap-2">
                             <button onClick={() => handleDeleteFolder(selectedFolderForManage.id)} className="px-4 py-2 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20 transition text-sm font-medium border border-red-500/20">Видалити</button>
                             <button onClick={() => handleSaveFolder(selectedFolderForManage)} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition text-sm font-medium shadow-lg shadow-blue-500/20">Зберегти в Telegram</button>
                         </div>
                     </div>
                     

                     <div className="flex flex-col gap-3">
                         <div className="flex items-center justify-between mt-4">
                             <h3 className="text-lg font-semibold text-slate-300">Додані чати ({selectedFolderForManage.includePeers?.length || 0}):</h3>
                             <button onClick={() => setShowAddChatModalForFolder(true)} className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white rounded-lg transition text-sm font-medium">
                                 + Додати чати
                             </button>
                         </div>
                         
                         {(selectedFolderForManage.includePeers || []).length === 0 ? (
                             <p className="text-slate-500 text-sm py-4 bg-slate-900/50 border border-slate-800/80 rounded-xl px-4 text-center">Конкретні чати ще не додані.</p>
                         ) : (
                             <div className="grid gap-2">
                                 {selectedFolderForManage.includePeers.map(peerId => {
                                     const matchedDialog = dialogs.find(d => String(d.id) === String(peerId)) || contacts.find(c => String(c.id) === String(peerId));
                                     return (
                                         <div key={peerId} onClick={() => { if(matchedDialog) { setSelectedDialog(matchedDialog); setActiveTab('messenger'); } }} className="flex justify-between items-center bg-slate-900 border border-slate-700/50 p-3 rounded-xl hover:border-slate-600 transition cursor-pointer">
                                             <div className="flex items-center gap-3 overflow-hidden">
                                                 <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0 text-white ${matchedDialog?.isGroup ? 'bg-indigo-600' : 'bg-slate-700'}`}>
                                                     {matchedDialog ? (matchedDialog.name || matchedDialog.firstName || "?").charAt(0) : '?'}
                                                 </div>
                                                 <div className="flex flex-col truncate">
                                                     <span className="font-medium text-slate-200 truncate">{matchedDialog ? (matchedDialog.name || `${matchedDialog.firstName||''} ${matchedDialog.lastName||''}`) : "Невідомий ID: "+peerId}</span>
                                                     <div className="flex flex-wrap gap-1 mt-1">
                                                         {assignments.filter(a => a.chat_id === String(peerId)).map(a => {
                                                             const t = tags.find(x => x.id === a.tag_id);
                                                             return t ? <span key={t.id} style={{backgroundColor: t.color}} className="text-[10px] text-white px-2 py-0.5 rounded-full">{t.name}</span> : null;
                                                         })}
                                                         <button onClick={(e) => { e.stopPropagation(); setTagModalUserId(peerId); }} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full transition border border-slate-700">
                                                             + Додати тег
                                                         </button>
                                                         {matchedDialog && (
                                                         <button onClick={(e) => { e.stopPropagation(); setSelectedDialog(matchedDialog); setShowChatNoteModal(true); }} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full transition border border-slate-700 flex items-center gap-1">
                                                             <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                                                             Коментарі
                                                         </button>
                                                         )}
                                                     </div>
                                                 </div>
                                             </div>
                                             <button onClick={(e) => { e.stopPropagation(); setSelectedFolderForManage({...selectedFolderForManage, includePeers: selectedFolderForManage.includePeers.filter(p => String(p) !== String(peerId))}) }} className="text-xs px-3 py-1.5 rounded-lg font-medium bg-slate-800 text-slate-300 hover:bg-red-500/20 hover:text-red-400 transition shrink-0 border border-slate-700">
                                                 Видалити
                                             </button>
                                         </div>
                                     )
                                 })}
                             </div>
                         )}
                     </div>
                 </div>
             ) : (
                 <div className="m-auto flex flex-col items-center gap-4 text-slate-500">
                     <svg className="w-16 h-16 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                     <p>Виберіть папку для налаштування</p>
                 </div>
             )}
          </div>
      </div>
      )}

      {/* Tags Manager Area */}
      {activeTab === 'tagsManager' && (
      <div className="flex-1 flex bg-[#0b101e] h-screen overflow-hidden">
          {/* Left Sidebar: Tags List */}
          <div className="w-1/3 min-w-[300px] border-r border-slate-700 flex flex-col h-full bg-slate-900 overflow-y-auto">
             <div className="p-4 border-b border-slate-700/50 sticky top-0 bg-slate-900/80 backdrop-blur z-10 flex flex-col gap-3">
                 <h2 className="text-xl font-bold text-slate-200">Ваші Теги</h2>
                 <div className="flex gap-2">
                     <input type="color" value={newTagColor} onChange={e => setNewTagColor(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer bg-transparent border-0 p-0" />
                     <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)} placeholder="Назва тегу..." className="flex-1 bg-slate-800 text-sm text-slate-200 border border-slate-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500" />
                 </div>
                 <button onClick={handleCreateTag} disabled={!newTagName} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition shadow-lg shadow-blue-500/20">
                     Створити новий тег
                 </button>
             </div>
             <div className="p-4 space-y-2">
                 {tags.length === 0 && <p className="text-slate-500 text-sm text-center py-4">Немає тегів</p>}
                 {tags.map(tag => (
                     <div key={tag.id} 
                          onClick={() => setSelectedTagForManage(tag)}
                          className={`p-3 rounded-xl border transition cursor-pointer flex items-center gap-3 ${selectedTagForManage?.id === tag.id ? 'bg-blue-500/10 border-blue-500/50' : 'bg-slate-800/50 border-slate-700 hover:border-slate-600'}`}>
                          <div className="w-4 h-4 rounded-full shadow-sm shrink-0" style={{backgroundColor: tag.color}}></div>
                          <span className="font-medium text-slate-200 truncate flex-1">{tag.name}</span>
                          <span className="text-xs text-slate-400 bg-slate-800 px-2 py-1 rounded-md">
                              {assignments.filter(a => a.tag_id === tag.id).length}
                          </span>
                     </div>
                 ))}
             </div>
          </div>
          
          {/* Right Panel: Manage Selected Tag */}
          <div className="flex-1 bg-[#0b101e] h-full flex flex-col overflow-y-auto hidden md:flex relative p-6">
             {selectedTagForManage ? (
                 <div className="max-w-3xl flex flex-col gap-6">
                     <div className="flex items-center justify-between pb-4 border-b border-slate-700/50">
                         <div className="flex items-center gap-3">
                             <input type="color" defaultValue={selectedTagForManage.color} onChange={e => handleUpdateTag(selectedTagForManage.id, selectedTagForManage.name, e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer bg-transparent border-0 p-0" />
                             <input type="text" defaultValue={selectedTagForManage.name} onBlur={e => handleUpdateTag(selectedTagForManage.id, e.target.value, selectedTagForManage.color)} className="bg-transparent text-2xl font-bold text-slate-200 outline-none border-b border-transparent focus:border-blue-500 transition px-1" />
                         </div>
                         <button onClick={() => handleDeleteTag(selectedTagForManage.id)} className="px-4 py-2 bg-red-500/10 text-red-500 rounded-lg hover:bg-red-500/20 transition text-sm font-medium border border-red-500/20">Видалити Тег</button>
                     </div>
                     
                     <div className="flex flex-col gap-3">
                         <div className="flex items-center justify-between">
                             <h3 className="text-lg font-semibold text-slate-300">Присвоєні клієнти/чати ({assignments.filter(a => a.tag_id === selectedTagForManage.id).length}):</h3>
                             <button onClick={() => setShowAddChatModalForTag(selectedTagForManage.id)} className="px-3 py-1.5 bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white rounded-lg transition text-sm font-medium">
                                 + Додати контакти
                             </button>
                         </div>
                         
                         {assignments.filter(a => a.tag_id === selectedTagForManage.id).length === 0 ? (
                             <p className="text-slate-500 text-sm py-4 bg-slate-900/50 border border-slate-800/80 rounded-xl px-4 text-center">Цей тег ще нікому не призначено.</p>
                         ) : (
                             <div className="grid gap-2">
                                 {assignments.filter(a => a.tag_id === selectedTagForManage.id).map(a => {
                                     const matchedDialog = dialogs.find(d => String(d.id) === String(a.chat_id));
                                     return (
                                         <div key={a.chat_id} className="flex justify-between items-center bg-slate-900 border border-slate-700/50 p-3 rounded-xl hover:border-slate-600 transition">
                                             <div className="flex items-center gap-3 overflow-hidden">
                                                 <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-blue-400 font-bold shrink-0">
                                                     {matchedDialog ? (matchedDialog.name || '').charAt(0) : '?'}
                                                 </div>
                                                 <div className="flex flex-col truncate">
                                                     <span className="font-medium text-slate-200 truncate">{matchedDialog ? matchedDialog.name : "Невідомий чат (ID " + a.chat_id + ")"}</span>
                                                     <span className="text-xs text-slate-500">
                                                        {matchedDialog ? (matchedDialog.isGroup ? 'Група' : matchedDialog.isChannel ? 'Канал' : 'Користувач') : 'Чат або Клієнт'}
                                                     </span>
                                                 </div>
                                             </div>
                                             <button onClick={() => handleToggleTag(a.chat_id, selectedTagForManage.id, true)} className="text-xs px-3 py-1.5 rounded-lg font-medium bg-slate-800 text-slate-300 hover:bg-red-500/20 hover:text-red-400 transition shrink-0 border border-slate-700 hover:border-red-500/30">
                                                 Відв'язати
                                             </button>
                                         </div>
                                     )
                                 })}
                             </div>
                         )}
                     </div>
                 </div>
             ) : (
                 <div className="m-auto flex flex-col items-center gap-4 text-slate-500">
                     <svg className="w-16 h-16 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" /></svg>
                     <p>Виберіть тег зліва для керування</p>
                 </div>
             )}
          </div>
      </div>
      )}

      {tagModalUserId && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-sm p-6 relative">
                  <button onClick={() => setTagModalUserId(null)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">Теги клієнта</h3>
                  
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-2 mb-4 scrollbar-hide">
                      {tags.length === 0 && <div className="text-sm text-slate-500">Немає доступних тегів. Створіть перший!</div>}
                      {tags.map(tag => {
                          const isAssigned = assignments.some(a => a.chat_id === String(tagModalUserId) && a.tag_id === tag.id);
                          return (
                              <div key={tag.id} className="flex justify-between items-center bg-slate-800/50 p-2 rounded-lg border border-slate-700/50">
                                  <div className="flex items-center gap-2">
                                      <span className="w-3 h-3 rounded-full shadow-sm" style={{backgroundColor: tag.color}}></span>
                                      <span className="text-sm text-slate-200">{tag.name}</span>
                                  </div>
                                  <button onClick={() => handleToggleTag(tagModalUserId, tag.id, isAssigned)} className={`text-xs px-3 py-1 rounded-md transition font-medium ${isAssigned ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'}`}>
                                      {isAssigned ? 'Зняти' : 'Додати'}
                                  </button>
                              </div>
                          );
                      })}
                  </div>
                  
                  <div className="border-t border-slate-700 pt-4 mt-2">
                      <p className="text-xs text-slate-400 mb-2">Створити новий тег</p>
                      <div className="flex gap-2">
                          <input type="color" value={newTagColor} onChange={e => setNewTagColor(e.target.value)} className="w-8 h-8 rounded shrink-0 cursor-pointer bg-transparent border-0 p-0" />
                          <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)} placeholder="Назва тегу..." className="flex-1 bg-slate-800 text-sm text-slate-200 border border-slate-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-500" />
                      </div>
                      <button onClick={handleCreateTag} disabled={!newTagName} className="w-full mt-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium py-2 rounded-lg transition shadow-lg shadow-blue-500/20">
                          Створити
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Add Contacts to Tag Modal */}
      {showAddChatModalForTag && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowAddChatModalForTag(null)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">Додати чат або контакт до тегу</h3>
                  
                  <input 
                      type="text" 
                      placeholder="Пошук (ім'я, username або телефон)..." 
                      value={tagChatSearchQuery}
                      onChange={(e) => setTagChatSearchQuery(e.target.value)}
                      className="w-full bg-slate-800 text-sm border border-slate-700 rounded-lg px-4 py-2 mb-4 outline-none focus:border-blue-500 transition"
                  />
                  
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2 scrollbar-hide">
                      {dialogs.concat(contacts.filter(c => !dialogs.find(d => String(d.id) === String(c.id))))
                          .filter(chat => {
                              const isAssigned = assignments.some(a => a.tag_id === showAddChatModalForTag && String(a.chat_id) === String(chat.id));
                              if (isAssigned) return false;
                              
                              if (!tagChatSearchQuery) return true;
                              const q = tagChatSearchQuery.toLowerCase();
                              const isGroupSearch = (q === 'група' && chat.isGroup);
                              return isGroupSearch ||
                                     (chat.name && chat.name.toLowerCase().includes(q)) ||
                                     (chat.firstName && chat.firstName.toLowerCase().includes(q)) ||
                                     (chat.lastName && chat.lastName.toLowerCase().includes(q)) ||
                                     (chat.username && chat.username.toLowerCase().includes(q)) ||
                                     (chat.phone && chat.phone.includes(tagChatSearchQuery));
                          })
                          .slice(0, 100)
                          .map(chat => (
                              <div key={chat.id} className="flex justify-between items-center bg-slate-800/50 p-2 rounded-lg border border-slate-700/50 hover:bg-slate-800 transition">
                                  <div className="flex items-center gap-3 overflow-hidden">
                                       <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0 text-sm ${chat.isGroup ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-700 text-blue-400'}`}>
                                           {(chat.name || chat.firstName || "?").charAt(0)}
                                       </div>
                                       <div className="flex flex-col truncate">
                                          <div className="flex items-center gap-2">
                                              <span className="text-sm text-slate-200 truncate">{chat.name || `${chat.firstName || ''} ${chat.lastName || ''}`.trim()}</span>
                                              {chat.isGroup && <span className="px-1.5 py-[1px] rounded bg-indigo-500/20 text-indigo-400 text-[9px] border border-indigo-500/30 uppercase font-bold shrink-0">Група</span>}
                                          </div>
                                          <span className="text-[10px] text-slate-500 truncate">
                                              {chat.username ? `@${chat.username}` : (chat.phone ? `+${chat.phone}` : (chat.isGroup ? 'Спільна Група' : 'Чат/Клієнт'))}
                                          </span>
                                       </div>
                                  </div>
                                  <button onClick={() => {
                                      handleToggleTag(chat.id, showAddChatModalForTag, false);
                                  }} className="text-xs px-3 py-1.5 rounded-md transition font-medium bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/20 shadow-md cursor-pointer shrink-0 leading-none">
                                      Додати
                                  </button>
                              </div>
                          ))}
                  </div>
              </div>
          </div>
      )}

      {/* Add Contacts to Folder Modal */}
      {showAddChatModalForFolder && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowAddChatModalForFolder(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">Додати чат до папки</h3>
                  
                  <input 
                      type="text" 
                      placeholder="Пошук (ім'я, username або телефон)..." 
                      value={folderChatSearchQuery}
                      onChange={(e) => setFolderChatSearchQuery(e.target.value)}
                      className="w-full bg-slate-800 text-sm border border-slate-700 rounded-lg px-4 py-2 mb-4 outline-none focus:border-blue-500 transition"
                  />
                  
                  <div className="flex-1 overflow-y-auto pr-2 space-y-2 scrollbar-hide">
                      {dialogs.concat(contacts.filter(c => !dialogs.find(d => String(d.id) === String(c.id))))
                          .filter(chat => {
                              const isAssigned = (selectedFolderForManage?.includePeers || []).some(id => String(id) === String(chat.id));
                              if (isAssigned) return false;
                              
                              if (!folderChatSearchQuery) return true;
                              const q = folderChatSearchQuery.toLowerCase();
                              const isGroupSearch = (q === 'група' && chat.isGroup);
                              return isGroupSearch ||
                                     (chat.name && chat.name.toLowerCase().includes(q)) ||
                                     (chat.firstName && chat.firstName.toLowerCase().includes(q)) ||
                                     (chat.lastName && chat.lastName.toLowerCase().includes(q)) ||
                                     (chat.username && chat.username.toLowerCase().includes(q)) ||
                                     (chat.phone && chat.phone.includes(folderChatSearchQuery));
                          })
                          .slice(0, 100)
                          .map(chat => (
                              <div key={chat.id} className="flex justify-between items-center bg-slate-800/50 p-2 rounded-lg border border-slate-700/50 hover:bg-slate-800 transition">
                                  <div className="flex items-center gap-3 overflow-hidden">
                                       <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold shrink-0 text-sm ${chat.isGroup ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-700 text-blue-400'}`}>
                                           {(chat.name || chat.firstName || "?").charAt(0)}
                                       </div>
                                       <div className="flex flex-col truncate">
                                          <div className="flex items-center gap-2">
                                              <span className="text-sm text-slate-200 truncate">{chat.name || `${chat.firstName || ''} ${chat.lastName || ''}`.trim()}</span>
                                              {chat.isGroup && <span className="px-1.5 py-[1px] rounded bg-indigo-500/20 text-indigo-400 text-[9px] border border-indigo-500/30 uppercase font-bold shrink-0">Група</span>}
                                          </div>
                                          <span className="text-[10px] text-slate-500 truncate">
                                              {chat.username ? `@${chat.username}` : (chat.phone ? `+${chat.phone}` : (chat.isGroup ? 'Спільна Група' : 'Чат/Клієнт'))}
                                          </span>
                                       </div>
                                  </div>
                                  <button onClick={() => {
                                      setSelectedFolderForManage({
                                          ...selectedFolderForManage, 
                                          includePeers: [...(selectedFolderForManage.includePeers || []), String(chat.id)]
                                      });
                                  }} className="text-xs px-3 py-1.5 rounded-md transition font-medium bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white border border-blue-500/20 shadow-md cursor-pointer shrink-0 leading-none">
                                      Додати
                                  </button>
                              </div>
                          ))}
                  </div>
              </div>
          </div>
      )}

      {/* Pinned Messages Modal */}
      {showPinnedMessages && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-2xl p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowPinnedMessages(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4 flex items-center gap-2">
                       <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                       </svg>
                       Закріплені повідомлення
                  </h3>
                  
                  <div className="flex-1 overflow-y-auto pr-2 space-y-3 scrollbar-hide">
                      {pinnedMessagesList.length === 0 ? (
                          <p className="text-center text-slate-500 py-10">В цьому чаті немає закріплених повідомлень.</p>
                      ) : (
                          pinnedMessagesList.map(msg => (
                              <div key={msg.id} className="bg-slate-800/50 p-3 rounded-xl border border-slate-700/50 flex flex-col gap-1">
                                  <div className="text-xs text-blue-400 mb-1">{new Date(msg.date * 1000).toLocaleString()}</div>
                                  <p className="text-sm text-slate-200 line-clamp-3 italic whitespace-pre-wrap">"{msg.text || '[Медіа]'}"</p>
                                  <div className="flex justify-end gap-2 mt-2">
                                      <button 
                                          onClick={() => {
                                              jumpToMessageInCurrentDialog(msg.id);
                                              setShowPinnedMessages(false);
                                          }}
                                          className="text-xs text-blue-400 hover:underline"
                                      >
                                          Перейти
                                      </button>
                                      <button 
                                          onClick={() => handlePinMessage(msg.id, true)}
                                          className="text-xs text-red-400 hover:underline"
                                      >
                                          Відкріпити
                                      </button>
                                  </div>
                              </div>
                          ))
                      )}
                  </div>
              </div>
          </div>
      )}

      {/* Create Group Modal */}
      {showCreateGroupModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowCreateGroupModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">Створити групу</h3>
                  
                  <div className="space-y-4">
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Назва групи</label>
                          <input 
                              type="text" 
                              value={newGroupTitle} 
                              onChange={e => setNewGroupTitle(e.target.value)} 
                              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 outline-none focus:border-blue-500 transition" 
                              placeholder="Введіть назву..."
                          />
                      </div>
                      
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Учасники ({newGroupMembers.length})</label>
                          <input 
                              type="text" 
                              placeholder="Пошук контактів..." 
                              value={groupSearchQuery} 
                              onChange={e => setGroupSearchQuery(e.target.value)} 
                              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition mb-2"
                          />
                          
                          <div className="max-h-60 overflow-y-auto space-y-1 pr-1 scrollbar-hide">
                              {contacts.filter(c => !groupSearchQuery || (c.firstName + ' ' + (c.lastName||'')).toLowerCase().includes(groupSearchQuery.toLowerCase()))
                                  .map(contact => {
                                      const isSelected = newGroupMembers.includes(String(contact.id)) || newGroupMembers.includes(contact.username);
                                      return (
                                          <div key={contact.id} 
                                               onClick={() => {
                                                   const id = contact.username || String(contact.id);
                                                   if (isSelected) setNewGroupMembers(prev => prev.filter(m => m !== id));
                                                   else setNewGroupMembers(prev => [...prev, id]);
                                               }}
                                               className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition ${isSelected ? 'bg-blue-600/20 border border-blue-500/30' : 'bg-slate-800/50 hover:bg-slate-800'}`}>
                                              <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center font-bold text-xs text-blue-400">
                                                  {(contact.firstName || contact.lastName || "?").charAt(0)}
                                              </div>
                                              <span className="text-sm text-slate-200 flex-1">{contact.firstName} {contact.lastName}</span>
                                              {isSelected && (
                                                  <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                                  </svg>
                                              )}
                                          </div>
                                      );
                                  })
                              }
                          </div>
                      </div>
                      
                      <button 
                          onClick={handleCreateGroup}
                          disabled={!newGroupTitle || newGroupMembers.length === 0}
                          className="w-full py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-xl transition shadow-lg shadow-blue-500/20"
                      >
                          Створити групу
                      </button>
                  </div>
              </div>
          </div>
      )}

      {/* Add Member Modal */}
      {showAddMemberModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowAddMemberModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-4">Додати учасника</h3>
                  
                  <input 
                      type="text" 
                      placeholder="Пошук контактів..." 
                      value={addMemberSearchQuery} 
                      onChange={e => setAddMemberSearchQuery(e.target.value)} 
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition mb-4"
                  />
                  
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                      {contacts.filter(c => !addMemberSearchQuery || (c.firstName + ' ' + (c.lastName||'')).toLowerCase().includes(addMemberSearchQuery.toLowerCase()))
                          .map(contact => (
                              <div key={contact.id} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:bg-slate-800 transition">
                                  <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center font-bold text-blue-400">
                                      {(contact.firstName || contact.lastName || "?").charAt(0)}
                                  </div>
                                  <div className="flex-1 flex flex-col">
                                      <span className="text-sm font-medium text-slate-200">{contact.firstName} {contact.lastName}</span>
                                      {contact.username && <span className="text-xs text-slate-500">@{contact.username}</span>}
                                  </div>
                                  <button 
                                      onClick={() => handleAddMemberToGroup(contact.username || contact.id)}
                                      className="px-4 py-1.5 bg-blue-600/20 hover:bg-blue-600 text-blue-400 hover:text-white rounded-lg transition text-xs font-medium border border-blue-500/20"
                                  >
                                      Додати
                                  </button>
                              </div>
                          ))
                      }
                  </div>
              </div>
          </div>
      )}

      {showManageMembersModal && selectedDialog && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[150] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-xl p-6 relative flex flex-col max-h-[80vh]">
                  <button onClick={() => setShowManageMembersModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-1">Учасники групи</h3>
                  <p className="text-sm text-slate-400 mb-4">{selectedDialog.name}</p>

                  <input
                      type="text"
                      placeholder="Пошук учасника..."
                      value={manageMemberSearchQuery}
                      onChange={e => setManageMemberSearchQuery(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition mb-4"
                  />

                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                      {participants
                          .filter(participant => {
                              const haystack = `${participant.firstName || ''} ${participant.lastName || ''} ${participant.username || ''}`.toLowerCase();
                              return !manageMemberSearchQuery || haystack.includes(manageMemberSearchQuery.toLowerCase());
                          })
                          .map(participant => (
                              <div key={participant.id} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50">
                                  <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center font-bold text-blue-400">
                                      {(participant.firstName || participant.lastName || participant.username || '?').charAt(0)}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-slate-200 truncate">{participant.firstName} {participant.lastName}</div>
                                      <div className="text-xs text-slate-500 truncate">{participant.username ? `@${participant.username}` : `ID: ${participant.id}`}</div>
                                  </div>
                                  <button
                                      onClick={() => handleRemoveMemberFromGroup(participant)}
                                      className="px-4 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-lg transition text-xs font-medium border border-red-500/20"
                                  >
                                      Видалити
                                  </button>
                              </div>
                          ))}
                      {participants.length === 0 && (
                          <div className="text-sm text-slate-500 text-center py-8">Список учасників поки порожній.</div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {showContactProfileModal && selectedContactProfile && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[250] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-md p-6 relative">
                  <button onClick={() => setShowContactProfileModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>

                  <div className="flex items-center gap-4">
                      <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-green-500 to-emerald-500 flex items-center justify-center font-bold text-white text-2xl shadow-lg">
                          {(selectedContactProfile.firstName || selectedContactProfile.lastName || selectedContactProfile.username || '?').charAt(0)}
                      </div>
                      <div className="min-w-0">
                          <h3 className="text-xl font-semibold text-white truncate">
                              {`${selectedContactProfile.firstName || ''} ${selectedContactProfile.lastName || ''}`.trim() || 'Без імені'}
                          </h3>
                          {selectedContactProfile.isMutualContact && (
                              <div className="mt-1 inline-flex px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 text-xs">
                                  Взаємний контакт
                              </div>
                          )}
                      </div>
                  </div>

                  <div className="mt-6 space-y-4">
                      <div className="rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Username</div>
                          <div className="text-sm text-slate-200 break-all">
                              {selectedContactProfile.username ? `@${selectedContactProfile.username}` : 'Не вказано'}
                          </div>
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Телефон</div>
                          <div className="text-sm text-slate-200 break-all">
                              {selectedContactProfile.phone ? `+${selectedContactProfile.phone}` : 'Не вказано'}
                          </div>
                      </div>

                      <div className="rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-3">
                          <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">Telegram ID</div>
                          <div className="text-sm text-slate-200 break-all">{selectedContactProfile.id}</div>
                      </div>
                  </div>

                  <div className="mt-6 flex gap-3">
                      <button
                          onClick={() => {
                              setShowContactProfileModal(false);
                              openChatById(selectedContactProfile.id);
                          }}
                          className="flex-1 px-4 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition font-medium"
                      >
                          Відкрити чат
                      </button>
                      <button
                          onClick={() => setShowContactProfileModal(false)}
                          className="px-4 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl transition font-medium border border-slate-700"
                      >
                          Закрити
                      </button>
                  </div>
              </div>
          </div>
      )}

      {showSendContactModal && (
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[260] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700 shadow-2xl rounded-2xl w-full max-w-lg p-6 relative flex flex-col max-h-[80vh]">
                  <button
                      onClick={() => {
                          setShowSendContactModal(false);
                          setSendContactSearchQuery('');
                      }}
                      className="absolute top-4 right-4 text-slate-400 hover:text-white"
                  >
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-semibold text-white mb-2">Надіслати контакт</h3>
                  <p className="text-sm text-slate-400 mb-4 truncate">Чат: {selectedDialog?.name || 'не обрано'}</p>
                  <input
                      type="text"
                      placeholder="Пошук контакту..."
                      value={sendContactSearchQuery}
                      onChange={(e) => setSendContactSearchQuery(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-blue-500 transition mb-4"
                  />
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1 scrollbar-hide">
                      {loadingContacts && (
                          <div className="text-sm text-slate-400 text-center py-6">Завантаження контактів...</div>
                      )}
                      {!loadingContacts && contacts
                          .filter((contact) => {
                              const q = sendContactSearchQuery.trim().toLowerCase();
                              if (!q) return true;
                              const haystack = `${contact.firstName || ''} ${contact.lastName || ''} ${contact.username || ''} ${contact.phone || ''}`.toLowerCase();
                              return haystack.includes(q);
                          })
                          .map((contact) => (
                              <div key={contact.id} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-xl border border-slate-700/50 hover:bg-slate-800 transition">
                                  <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center font-bold text-blue-400 shrink-0">
                                      {(contact.firstName || contact.lastName || contact.username || '?').charAt(0)}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                      <div className="text-sm font-medium text-slate-200 truncate">{getContactDisplayName(contact)}</div>
                                      <div className="text-xs text-slate-500 truncate">{contact.phone ? `+${contact.phone}` : (contact.username ? `@${contact.username}` : `ID: ${contact.id}`)}</div>
                                  </div>
                                  <button
                                      type="button"
                                      onClick={async () => {
                                          await handleSendCrmContact(contact);
                                          setShowSendContactModal(false);
                                          setSendContactSearchQuery('');
                                      }}
                                      className="px-4 py-1.5 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white rounded-lg transition text-xs font-medium border border-emerald-500/20"
                                  >
                                      Надіслати
                                  </button>
                              </div>
                          ))}
                      {!loadingContacts && contacts.length === 0 && (
                          <div className="text-sm text-slate-500 text-center py-8">Контакти не знайдені.</div>
                      )}
                  </div>
              </div>
          </div>
      )}

      {/* Settings Modal */}
      {showSettingsModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-md z-[200] flex items-center justify-center p-4">
              <div className="bg-slate-900 border border-slate-700/50 p-8 rounded-2xl shadow-2xl max-w-md w-full relative">
                  <button onClick={() => setShowSettingsModal(false)} className="absolute top-4 right-4 text-slate-400 hover:text-white transition">
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-2">
                       <svg className="w-6 h-6 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                           <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                       </svg>
                       Налаштування API
                  </h3>
                  <p className="text-slate-400 text-xs mb-6 italic">Ви можете отримати ці дані на сайті <a href="https://my.telegram.org/" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">my.telegram.org</a>. Вони необхідні для підключення до серверів Telegram.</p>
                  
                  <div className="space-y-4 mb-6">
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API ID</label>
                          <input type="text" value={settingsApiId} onChange={e => setSettingsApiId(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 outline-none focus:border-blue-500 transition" />
                      </div>
                      <div>
                          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">API Hash (нове значення)</label>
                          <input type="password" value={settingsApiHash} onChange={e => setSettingsApiHash(e.target.value)} className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-slate-200 outline-none focus:border-blue-500 transition" placeholder="Введіть новий Hash, якщо хочете змінити" />
                      </div>
                      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                          <div className="flex items-center justify-between gap-3">
                              <div>
                                  <div className="text-xs font-semibold text-slate-300">Автозавантаження відео</div>
                                  <div className="text-[11px] text-slate-500 mt-1">Якщо вимкнути, відео завантажується вручну кнопкою в чаті.</div>
                              </div>
                              <button
                                  type="button"
                                  onClick={() => setAutoDownloadVideos((prev) => !prev)}
                                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${autoDownloadVideos ? 'bg-blue-600' : 'bg-slate-600'}`}
                              >
                                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${autoDownloadVideos ? 'translate-x-5' : 'translate-x-1'}`} />
                              </button>
                          </div>
                      </div>
                      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-3">
                          <div className="flex items-start justify-between gap-3">
                              <div>
                                  <div className="text-xs font-semibold text-slate-300">Локальне сховище</div>
                                  <div className="text-[11px] text-slate-500 mt-1">
                                      Медіа: {formatBytes(mediaStorageStats.mediaBytes)} | Аватари: {formatBytes(mediaStorageStats.avatarsBytes)}
                                  </div>
                                  <div className="text-sm text-slate-200 mt-1">Разом: {formatBytes(mediaStorageStats.totalBytes)}</div>
                              </div>
                              <button
                                  type="button"
                                  onClick={handleClearMediaStorage}
                                  disabled={clearingMediaStorage || loadingMediaStorage}
                                  className="px-3 py-2 text-xs rounded-lg border border-red-500/30 text-red-300 hover:bg-red-500/10 disabled:opacity-60 transition"
                              >
                                  {clearingMediaStorage ? 'Очищення...' : 'Видалити всі медіа'}
                              </button>
                          </div>
                      </div>
                  </div>
                  <button onClick={handleSaveSettings} className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition font-medium mb-3">
                      Зберегти
                  </button>
                  <button onClick={handleLogout} className="w-full py-2 bg-red-600/20 hover:bg-red-600 text-red-500 hover:text-white border border-red-500/20 rounded-lg transition font-medium">
                      Вийти з Telegram
                  </button>
                  <button onClick={handleClearSession} className="w-full py-2 bg-red-700/10 hover:bg-red-700 text-red-400 hover:text-white border border-red-700/30 rounded-lg transition font-medium mt-3">
                      Очистити сесію і дані
                  </button>
              </div>
          </div>
      )}

    </div>
  );
}

export default App;
