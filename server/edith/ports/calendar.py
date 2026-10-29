"""Calendar (today: Google Calendar via adapters/google). Times are timezone-aware."""
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol


@dataclass
class CalendarInfo:
    id: str
    name: str
    access_role: str


@dataclass
class CalendarEvent:
    id: str
    calendar_id: str
    calendar: str               # the calendar's display name
    title: str
    start: datetime | date      # a date for all-day events
    end: datetime | date
    location: str = ""
    meet_link: str = ""

    @property
    def all_day(self) -> bool:
        return not isinstance(self.start, datetime)


@dataclass
class NewEvent:
    title: str
    start: datetime
    end: datetime
    description: str = ""
    location: str = ""
    attendees: list[str] = field(default_factory=list)
    meet: bool = False          # add a Google Meet link
    calendar_id: str = "primary"


@dataclass
class CreatedEvent:
    id: str
    link: str
    meet_link: str = ""


class Calendar(Protocol):
    def calendars(self) -> list[CalendarInfo]:
        """The calendars Arpit has selected."""

    def events(self, start: datetime, end: datetime) -> list[CalendarEvent]:
        """Events from all selected calendars, sorted by start, cancelled ones left out."""

    def create(self, event: NewEvent) -> CreatedEvent:
        """Only when Arpit has said yes. Invites go out only if there are attendees."""

    def delete(self, event_id: str, calendar_id: str = "primary") -> None:
        """Only when Arpit has said yes."""
