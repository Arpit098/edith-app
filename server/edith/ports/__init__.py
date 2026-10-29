"""Ports: interfaces for outside services. Adapters implement them; features depend only on these."""
from .agent import AgentBackend, RunInfo, StopResult, TurnHandle
from .calendar import Calendar, CalendarEvent, CalendarInfo, CreatedEvent, NewEvent
from .frontend import Frontend
from .mail import MailBox, MailMessage, MailSummary
from .notifier import Notifier
from .stt import SpeechToText, SttError, Transcript

__all__ = ["AgentBackend", "Calendar", "CalendarEvent", "CalendarInfo", "CreatedEvent", "Frontend", "MailBox",
           "MailMessage", "MailSummary", "NewEvent", "Notifier", "RunInfo", "SpeechToText", "SttError", "StopResult",
           "Transcript", "TurnHandle"]
